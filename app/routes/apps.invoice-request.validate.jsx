import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import soap from "soap";

const STORE_COUNTRY_CODE = (process.env.STORE_COUNTRY_CODE || "IT").toUpperCase();
const ENABLE_VIES_CHECK = (process.env.ENABLE_VIES_CHECK || "true") === "true";
const VIES_WSDL = "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";
const EU_REVERSE_CHARGE_EXEMPTION = "EU_REVERSE_CHARGE_EXEMPTION_RULE";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
  "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

function responseJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clean(value) {
  return String(value || "").trim();
}

function cleanUpper(value) {
  return clean(value).toUpperCase();
}

function cleanEmailLike(value) {
  return clean(value).toLowerCase();
}

function normalizeVat(countryCode, vatNumber) {
  const country = cleanUpper(countryCode);
  let vat = cleanUpper(vatNumber).replace(/[\s.\-_/]/g, "");

  if (country && vat.startsWith(country)) {
    vat = vat.slice(country.length);
  }

  if (country === "AT" && /^\d{8}$/.test(vat)) {
    vat = `U${vat}`;
  }

  return { countryCode: country, vatNumber: vat };
}

function normalizeFullVat(value) {
  return cleanUpper(value).replace(/[\s.\-_/]/g, "");
}

function classifyViesSoapError(error) {
  const message = String(error?.message || error || "");
  const raw = JSON.stringify(error || {});
  const combined = `${message} ${raw}`.toUpperCase();

  if (combined.includes("MS_MAX_CONCURRENT_REQ")) return "MS_MAX_CONCURRENT_REQ";
  if (combined.includes("MS_UNAVAILABLE")) return "MS_UNAVAILABLE";
  if (combined.includes("SERVICE_UNAVAILABLE")) return "SERVICE_UNAVAILABLE";
  if (combined.includes("TIMEOUT") || combined.includes("ETIMEDOUT") || combined.includes("ECONNRESET")) return "TIMEOUT";
  if (combined.includes("INVALID_INPUT")) return "INVALID_INPUT";

  return "VIES_TECHNICAL_ERROR";
}

function localeFrom(value) {
  return clean(value).toLowerCase().startsWith("it") ? "it" : "en";
}

function messages(locale) {
  const isIt = localeFrom(locale) === "it";

  return {
    invalidType: isIt ? "Tipo fattura non valido." : "Invalid invoice type.",
    requiredVat: isIt
      ? "Paese e partita IVA sono obbligatori."
      : "Country and VAT number are required.",
    viesUnavailable: () =>
      isIt
        ? "VIES momentaneamente occupato. Richiesta fattura registrata: completa il checkout e, se ti serve reverse charge, contatta l’assistenza."
        : "VIES is temporarily busy. Your invoice request was saved: complete checkout and contact support if you need reverse charge.",
    invalidVat: (fullVatNumber) =>
      isIt
        ? `VAT non validato (${fullVatNumber}). Richiesta fattura registrata: completa il checkout e contatta l’assistenza se serve verifica.`
        : `VAT could not be validated (${fullVatNumber}). Your invoice request was saved: complete checkout and contact support if you need verification.`,
    reverseChargeSaved: isIt
      ? "Reverse charge validato. La richiesta fattura è stata salvata."
      : "Reverse charge validated. Your invoice request has been saved.",
    taxExemptPrepared: isIt
      ? "Reverse charge validato e profilo cliente preparato per esenzione IVA. Usa la stessa email al checkout."
      : "Reverse charge validated and customer profile prepared for VAT exemption. Use the same email at checkout.",
    loggedTaxExemptApplied: isIt
      ? "Reverse charge validato e profilo cliente aggiornato per esenzione IVA."
      : "Reverse charge validated and customer profile updated for VAT exemption.",
  };
}

function viesUnavailableMessage(countryCode, fullVatNumber, locale = "it") {
  return messages(locale).viesUnavailable(countryCode, fullVatNumber);
}

function toCustomerGid(customerId) {
  const raw = clean(customerId);
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return await request.json();
  }

  const formData = await request.formData();
  return Object.fromEntries(formData.entries());
}

async function checkVies(countryCode, vatNumber) {
  const normalized = normalizeVat(countryCode, vatNumber);

  if (!normalized.countryCode || !normalized.vatNumber) {
    throw new Error("Paese e partita IVA sono obbligatori.");
  }

  console.log("[Invoice Request] VIES SOAP request", {
    countryCode: normalized.countryCode,
    vatNumber: normalized.vatNumber,
  });

  try {
    const client = await soap.createClientAsync(VIES_WSDL);
    const [result] = await client.checkVatAsync({
      countryCode: normalized.countryCode,
      vatNumber: normalized.vatNumber,
    });

    const response = {
      valid: result?.valid === true || String(result?.valid).toLowerCase() === "true",
      unavailable: false,
      countryCode: normalized.countryCode,
      vatNumber: normalized.vatNumber,
      fullVatNumber: `${normalized.countryCode}${normalized.vatNumber}`,
      requestDate: result?.requestDate || "",
      name: result?.name || "",
      address: result?.address || "",
      raw: result || null,
    };

    console.log("[Invoice Request] VIES SOAP response", response);

    return response;
  } catch (error) {
    const errorCode = classifyViesSoapError(error);
    const response = {
      valid: null,
      unavailable: true,
      errorCode,
      errorMessage: error?.message || String(error || ""),
      countryCode: normalized.countryCode,
      vatNumber: normalized.vatNumber,
      fullVatNumber: `${normalized.countryCode}${normalized.vatNumber}`,
      raw: null,
    };

    console.error("[Invoice Request] VIES SOAP unavailable", response);

    return response;
  }
}

async function graphQL(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function setCustomerMetafields(admin, customerGid, fields) {
  if (!customerGid) return;

  const metafields = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({
      ownerId: customerGid,
      namespace: "custom",
      key,
      type: "single_line_text_field",
      value: String(value),
    }));

  if (!metafields.length) return;

  const mutation = `#graphql
    mutation SetCustomerInvoiceMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, { metafields });
  const errors = data?.data?.metafieldsSet?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }
}


async function findCustomerByEmail(admin, email) {
  const cleanEmail = cleanEmailLike(email);
  if (!cleanEmail) return null;

  const query = `#graphql
    query FindInvoiceCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        nodes {
          id
          email
          taxExempt
          taxExemptions
        }
      }
    }
  `;

  const data = await graphQL(admin, query, { query: `email:${cleanEmail}` });
  const customer = data?.data?.customers?.nodes?.[0] || null;

  console.log("[Invoice Request] customer lookup by email", {
    email: cleanEmail,
    found: Boolean(customer?.id),
    customerId: customer?.id || "",
    taxExempt: customer?.taxExempt ?? null,
    taxExemptions: customer?.taxExemptions || [],
  });

  return customer;
}

async function createCustomerForInvoice(admin, email, companyName, firstName = "", lastName = "") {
  const cleanEmail = cleanEmailLike(email);
  if (!cleanEmail) return null;

  const mutation = `#graphql
    mutation CreateInvoiceCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
          taxExempt
          taxExemptions
        }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    input: {
      email: cleanEmail,
      ...(clean(firstName) ? { firstName: clean(firstName) } : {}),
      ...(clean(lastName) ? { lastName: clean(lastName) } : {}),
      note: companyName
        ? `Invoice request reverse charge - ${companyName}`
        : "Invoice request reverse charge",
    },
  });

  const errors = data?.data?.customerCreate?.userErrors || [];
  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");
    console.error("[Invoice Request] customerCreate failed", {
      email: cleanEmail,
      errors,
    });
    throw new Error(message);
  }

  const customer = data?.data?.customerCreate?.customer || null;

  console.log("[Invoice Request] customer created for invoice", {
    email: cleanEmail,
    customerId: customer?.id || "",
  });

  return customer;
}

async function findOrCreateCustomerByEmail(admin, email, companyName, firstName = "", lastName = "") {
  const existing = await findCustomerByEmail(admin, email);
  if (existing?.id) return existing;
  return createCustomerForInvoice(admin, email, companyName, firstName, lastName);
}

function normalizeVatForCompany(value) {
  return cleanUpper(value).replace(/[\s.\-_/]/g, "");
}

function temporaryCompanyName(vatNumber) {
  const vat = normalizeVatForCompany(vatNumber);
  return vat ? `invoice-${vat}` : "Invoice company";
}

async function getPreCheckoutCompanyFromCustomer(admin, customerGid, vatNumber) {
  if (!customerGid) return null;

  const wantedExternalId = `invoice-${normalizeVatForCompany(vatNumber)}`;
  const query = `#graphql
    query InvoicePreCheckoutCustomerCompanies($id: ID!) {
      customer(id: $id) {
        companyContactProfiles(first: 20) {
          nodes {
            id
            roleAssignments(first: 50) {
              nodes {
                id
                companyLocation { id }
                role { id name }
              }
            }
            company {
              id
              name
              externalId
              locations(first: 20) { nodes { id name } }
              defaultRole { id name }
              contactRoles(first: 20) { nodes { id name } }
            }
          }
        }
      }
    }
  `;

  const data = await graphQL(admin, query, { id: customerGid });
  const profiles = data?.data?.customer?.companyContactProfiles?.nodes || [];

  const exactVatProfile = profiles.find(
    (profile) => clean(profile?.company?.externalId) === wantedExternalId,
  );
  if (exactVatProfile?.company?.id) {
    return { company: exactVatProfile.company, companyContact: exactVatProfile };
  }

  // Most invoice customers belong to a single company already. Reuse it instead of
  // creating a duplicate just because it predates the invoice-* externalId convention.
  if (profiles.length === 1 && profiles[0]?.company?.id) {
    return { company: profiles[0].company, companyContact: profiles[0] };
  }

  return null;
}

async function findPreCheckoutCompanyByVat(admin, vatNumber) {
  const vat = normalizeVatForCompany(vatNumber);
  if (!vat) return null;

  const externalId = `invoice-${vat}`;
  const query = `#graphql
    query InvoicePreCheckoutCompanyByVat($query: String!) {
      companies(first: 10, query: $query) {
        nodes {
          id
          name
          externalId
          locations(first: 20) { nodes { id name } }
          defaultRole { id name }
          contactRoles(first: 20) { nodes { id name } }
        }
      }
    }
  `;

  const data = await graphQL(admin, query, { query: `external_id:${externalId}` });
  return (data?.data?.companies?.nodes || []).find(
    (company) => clean(company?.externalId) === externalId,
  ) || null;
}

async function createMinimalPreCheckoutCompany(admin, vatNumber) {
  const vat = normalizeVatForCompany(vatNumber);
  if (!vat) throw new Error("VAT mancante durante la preparazione Company B2B");

  const name = temporaryCompanyName(vat);
  const externalId = `invoice-${vat}`;
  const mutation = `#graphql
    mutation CreateInvoicePreCheckoutCompany($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          name
          externalId
          locations(first: 20) { nodes { id name } }
          defaultRole { id name }
          contactRoles(first: 20) { nodes { id name } }
        }
        userErrors { field message code }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    input: {
      company: { name, externalId },
    },
  });
  const errors = data?.data?.companyCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" | "));

  return data?.data?.companyCreate?.company || null;
}

async function getCompanyContactForCustomer(admin, companyId, customerGid) {
  if (!companyId || !customerGid) return null;

  const query = `#graphql
    query InvoicePreCheckoutCompanyContact($companyId: ID!) {
      company(id: $companyId) {
        contacts(first: 100) {
          nodes {
            id
            customer { id }
            roleAssignments(first: 50) {
              nodes {
                id
                companyLocation { id }
                role { id name }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphQL(admin, query, { companyId });
  return (data?.data?.company?.contacts?.nodes || []).find(
    (contact) => contact?.customer?.id === customerGid,
  ) || null;
}

async function assignCustomerToPreCheckoutCompany(admin, companyId, customerGid) {
  const existing = await getCompanyContactForCustomer(admin, companyId, customerGid);
  if (existing?.id) return existing;

  const mutation = `#graphql
    mutation AssignInvoicePreCheckoutCustomer($companyId: ID!, $customerId: ID!) {
      companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
        companyContact {
          id
          customer { id }
          roleAssignments(first: 50) {
            nodes {
              id
              companyLocation { id }
              role { id name }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, { companyId, customerId: customerGid });
  const errors = data?.data?.companyAssignCustomerAsContact?.userErrors || [];
  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");
    if (!/already|contact/i.test(message)) throw new Error(message);
    return getCompanyContactForCustomer(admin, companyId, customerGid);
  }

  return data?.data?.companyAssignCustomerAsContact?.companyContact || null;
}

function findOrderingRole(company) {
  const roles = company?.contactRoles?.nodes || [];
  const orderingRole = roles.find((role) => {
    const name = clean(role?.name).toLowerCase();
    return name === "buyer" || name === "ordering only" || name.includes("ordering");
  });
  if (orderingRole?.id) return orderingRole;

  const defaultName = clean(company?.defaultRole?.name).toLowerCase();
  if (
    company?.defaultRole?.id &&
    (defaultName === "buyer" || defaultName === "ordering only" || defaultName.includes("ordering"))
  ) {
    return company.defaultRole;
  }

  return null;
}

async function assignPreCheckoutOrderingRole(admin, company, companyContact, locationId) {
  if (!company?.id || !companyContact?.id || !locationId) {
    throw new Error("Company/Contact/Location mancanti durante autorizzazione B2B");
  }

  const alreadyAssigned = (companyContact?.roleAssignments?.nodes || []).some((assignment) => {
    if (assignment?.companyLocation?.id !== locationId) return false;
    const roleName = clean(assignment?.role?.name).toLowerCase();
    return roleName === "buyer" || roleName === "ordering only" || roleName.includes("ordering");
  });
  if (alreadyAssigned) return;

  const orderingRole = findOrderingRole(company);
  if (!orderingRole?.id) {
    throw new Error(`Ruolo Ordering only non trovato per Company ${company.id}`);
  }

  const mutation = `#graphql
    mutation AssignInvoicePreCheckoutOrderingRole(
      $companyContactId: ID!,
      $companyContactRoleId: ID!,
      $companyLocationId: ID!
    ) {
      companyContactAssignRole(
        companyContactId: $companyContactId,
        companyContactRoleId: $companyContactRoleId,
        companyLocationId: $companyLocationId
      ) {
        companyContactRoleAssignment { id }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    companyContactId: companyContact.id,
    companyContactRoleId: orderingRole.id,
    companyLocationId: locationId,
  });
  const errors = data?.data?.companyContactAssignRole?.userErrors || [];
  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");
    if (!/already|assigned/i.test(message)) throw new Error(message);
  }
}

async function ensurePreCheckoutInvoiceCompany(admin, customerGid, vatNumber) {
  if (!customerGid || !vatNumber) return null;

  const linked = await getPreCheckoutCompanyFromCustomer(admin, customerGid, vatNumber);
  let company = linked?.company || null;
  let companyContact = linked?.companyContact || null;

  if (!company?.id) company = await findPreCheckoutCompanyByVat(admin, vatNumber);
  if (!company?.id) company = await createMinimalPreCheckoutCompany(admin, vatNumber);
  if (!company?.id) throw new Error("Creazione Company B2B non riuscita");

  if (!companyContact?.id) {
    companyContact = await assignCustomerToPreCheckoutCompany(admin, company.id, customerGid);
  }
  if (!companyContact?.id) throw new Error("Associazione Customer → Company non riuscita");

  const locationId = company?.locations?.nodes?.[0]?.id || "";
  if (!locationId) throw new Error("Company B2B senza sede predefinita");

  await assignPreCheckoutOrderingRole(admin, company, companyContact, locationId);

  console.log("[Invoice Request] pre-checkout B2B company prepared", {
    customerGid,
    companyId: company.id,
    companyName: company.name,
    companyLocationId: locationId,
    vatNumber: normalizeVatForCompany(vatNumber),
  });

  return { companyId: company.id, locationId };
}

async function applyReverseCharge(admin, customerGid) {
  if (!customerGid) {
    return {
      applied: false,
      customerTaxExempt: false,
      customerTaxExemptions: [],
      error: "Missing customer ID",
    };
  }

  const mutation = `#graphql
    mutation ApplyInvoiceReverseCharge($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer {
          id
          taxExempt
          taxExemptions
        }
        userErrors { field message }
      }
    }
  `;

  const data = await graphQL(admin, mutation, {
    input: {
      id: customerGid,
      taxExempt: true,
      taxExemptions: [EU_REVERSE_CHARGE_EXEMPTION],
    },
  });

  const errors = data?.data?.customerUpdate?.userErrors || [];

  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");
    console.error("[Invoice Request] customerUpdate tax exemption failed", {
      customerGid,
      errors,
    });
    throw new Error(message);
  }

  const customer = data?.data?.customerUpdate?.customer;
  const customerTaxExempt = Boolean(customer?.taxExempt);
  const customerTaxExemptions = customer?.taxExemptions || [];
  const applied =
    customerTaxExempt === true &&
    customerTaxExemptions.includes(EU_REVERSE_CHARGE_EXEMPTION);

  console.log("[Invoice Request] customer tax exemption result", {
    customerGid,
    customerTaxExempt,
    customerTaxExemptions,
    applied,
  });

  return {
    applied,
    customerTaxExempt,
    customerTaxExemptions,
    error: applied ? "" : "Reverse charge exemption was not confirmed on the customer.",
  };
}

async function createOrUpdateInvoiceRequest({ shop, cartToken, data }) {
  if (cartToken) {
    const existing = await prisma.invoiceRequest.findFirst({
      where: {
        shop,
        cartToken,
        orderId: null,
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return prisma.invoiceRequest.update({
        where: { id: existing.id },
        data,
      });
    }
  }

  return prisma.invoiceRequest.create({
    data: {
      shop,
      ...data,
    },
  });
}

export async function loader() {
  return new Response("Invoice request app proxy is alive", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function action({ request }) {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin || !session?.shop) {
    return responseJson({ ok: false, error: "App proxy unavailable" }, 401);
  }

  const url = new URL(request.url);
  const proxyCustomerId = clean(url.searchParams.get("logged_in_customer_id"));
  const body = await readJson(request);
  const locale = localeFrom(body.locale);
  const i18n = messages(locale);

  const invoiceType = clean(body.invoiceType);
  const cartToken = clean(body.cartToken);
  const checkoutToken = clean(body.checkoutToken);
  const customerId = clean(body.customerId) || proxyCustomerId;
  const customerGid = toCustomerGid(customerId);
  const customerEmail = cleanEmailLike(body.customerEmail);

  const fiscalCode = cleanUpper(body.fiscalCode);
  const pec = cleanEmailLike(body.pec);
  const sdi = cleanUpper(body.sdi);
  const companyName = clean(body.companyName);
  const firstName = clean(body.firstName);
  const lastName = clean(body.lastName);

  const normalized = normalizeVat(body.countryCode, body.vatNumber);
  const countryCode = normalized.countryCode;
  const vatNumber = normalized.vatNumber;
  const fullVatNumber = vatNumber ? `${countryCode}${vatNumber}` : "";

  if (!["private", "company"].includes(invoiceType)) {
    return responseJson({ ok: false, error: i18n.invalidType }, 400);
  }

  if (invoiceType === "company" && (!countryCode || !vatNumber)) {
    return responseJson({ ok: false, error: i18n.requiredVat }, 400);
  }

  let viesChecked = false;
  let viesValid = null;
  let viesRawResponse = null;
  let viesUnavailable = false;
  let reverseCharge = false;
  let taxExemptApplied = false;
  let taxExemptCustomerPrepared = false;
  let mustUseSameEmailAtCheckout = false;
  let requiresLoginForTaxExemption = false;
  let preparedCustomerGid = customerGid;

  try {
    // BUSINESS PRE-CHECKOUT PREPARATION:
    // Create/find the Shopify Customer and make it an authorized B2B buyer BEFORE
    // Shopify creates the order. This is what lets checkout use the Company purchasing context.
    if (invoiceType === "company") {
      if (!preparedCustomerGid && customerEmail) {
        const customerByEmail = await findOrCreateCustomerByEmail(
          admin,
          customerEmail,
          companyName,
          firstName,
          lastName,
        );
        preparedCustomerGid = customerByEmail?.id || "";
      }

      if (preparedCustomerGid) {
        await ensurePreCheckoutInvoiceCompany(admin, preparedCustomerGid, fullVatNumber);
        mustUseSameEmailAtCheckout = Boolean(customerEmail);
      } else {
        console.warn("[Invoice Request] B2B pre-checkout preparation skipped: no Customer ID/email", {
          customerEmail,
          customerId,
          vatNumber: fullVatNumber,
        });
      }
    }

    const shouldCheckVies =
      invoiceType === "company" &&
      ENABLE_VIES_CHECK &&
      EU_COUNTRIES.has(countryCode) &&
      countryCode !== STORE_COUNTRY_CODE;

    if (shouldCheckVies) {
      viesChecked = true;
      viesRawResponse = await checkVies(countryCode, vatNumber);
      viesValid = viesRawResponse?.valid === true ? true : viesRawResponse?.valid === false ? false : null;
      reverseCharge = viesValid === true;

      if (viesRawResponse?.unavailable) {
        // Business rule: never block checkout for technical VIES failures.
        // The invoice request is saved for manual review, but reverse charge/tax exempt
        // are NOT applied automatically because VIES did not confirm validity.
        viesUnavailable = true;
        viesChecked = false;
        viesValid = null;
        reverseCharge = false;
      }

      if (!viesUnavailable && viesValid !== true) {
        const errorMessage = i18n.invalidVat(fullVatNumber);
        const invoiceRequest = await createOrUpdateInvoiceRequest({
          shop: session.shop,
          cartToken,
          data: {
            cartToken,
            checkoutToken,
            customerId: preparedCustomerGid || customerGid || customerId,
            customerEmail,
            invoiceType,
            countryCode,
            fiscalCode,
            vatNumber: fullVatNumber,
            pec,
            sdi,
            companyName,
            firstName,
            lastName,
            viesChecked,
            viesValid: false,
            viesRawResponse: JSON.stringify(viesRawResponse),
            reverseCharge: false,
            taxExemptApplied: false,
            status: "pending_review",
            errorMessage,
          },
        });

        return responseJson({
          ok: true,
          invoiceRequestId: invoiceRequest.id,
          invoiceType,
          vatNumber: fullVatNumber,
          viesChecked,
          viesValid: false,
          reverseCharge: false,
          taxExemptApplied: false,
          taxExemptCustomerPrepared: false,
          pendingManualReview: true,
          reviewRequired: true,
          viesTechnicalError: false,
          customerEmail,
          customerId: preparedCustomerGid || customerGid || customerId || "",
          message: errorMessage,
        });
      }

      if (reverseCharge && preparedCustomerGid) {
        const taxExemptResult = await applyReverseCharge(admin, preparedCustomerGid);
        taxExemptApplied = Boolean(taxExemptResult.applied);
        taxExemptCustomerPrepared = taxExemptApplied;
        mustUseSameEmailAtCheckout = Boolean(customerEmail) || mustUseSameEmailAtCheckout;
      } else if (reverseCharge && !preparedCustomerGid) {
        requiresLoginForTaxExemption = true;
      }
    }

    if (preparedCustomerGid) {
      await setCustomerMetafields(admin, preparedCustomerGid, {
        invoice_type: invoiceType,
        fiscal_code: fiscalCode,
        vat_number: fullVatNumber,
        invoice_country_code: countryCode,
        pec,
        sdi,
        company_name: companyName,
        vies_checked: String(viesChecked),
        vies_valid: viesValid === null ? "" : String(viesValid),
        reverse_charge: String(reverseCharge),
      });
    }

    const invoiceRequest = await createOrUpdateInvoiceRequest({
      shop: session.shop,
      cartToken,
      data: {
        cartToken,
        checkoutToken,
        customerId: preparedCustomerGid || customerGid || customerId,
        customerEmail,
        invoiceType,
        countryCode,
        fiscalCode,
        vatNumber: fullVatNumber,
        pec,
        sdi,
        companyName,
        firstName,
        lastName,
        viesChecked,
        viesValid,
        viesRawResponse: viesRawResponse ? JSON.stringify(viesRawResponse) : null,
        reverseCharge,
        taxExemptApplied,
        status: viesUnavailable ? "pending_review" : invoiceType === "private" ? "registered" : "validated",
        errorMessage: viesUnavailable
          ? `Errore tecnico VIES: ${viesRawResponse?.errorCode || "VIES_UNAVAILABLE"}${viesRawResponse?.errorMessage ? ` - ${viesRawResponse.errorMessage}` : ""}`
          : taxExemptApplied || taxExemptCustomerPrepared || !reverseCharge
            ? null
            : "VIES valido, ma reverse charge non confermato sul cliente Shopify.",
      },
    });

    return responseJson({
      ok: true,
      invoiceRequestId: invoiceRequest.id,
      invoiceType,
      vatNumber: fullVatNumber,
      viesChecked,
      viesValid,
      reverseCharge,
      taxExemptApplied,
      viesUnavailable,
      viesTechnicalError: viesUnavailable,
      pendingManualReview: viesUnavailable,
      taxExemptCustomerPrepared,
      reviewRequired: viesUnavailable,
      viesErrorCode: viesRawResponse?.errorCode || "",
      mustUseSameEmailAtCheckout,
      requiresLoginForTaxExemption,
      customerEmail,
      customerId: preparedCustomerGid || customerGid || customerId || "",
      message: reverseCharge
        ? viesUnavailable
          ? i18n.viesUnavailable()
          : customerGid && taxExemptApplied
            ? i18n.loggedTaxExemptApplied
            : taxExemptCustomerPrepared
              ? i18n.taxExemptPrepared
              : i18n.reverseChargeSaved
        : undefined,
    });
  } catch (error) {
    console.error("[Invoice Request] validate failed", {
      message: error?.message,
      invoiceType,
      countryCode,
      vatNumber: fullVatNumber,
      customerId: preparedCustomerGid || customerGid || customerId,
      proxyCustomerId,
      reverseCharge,
      taxExemptApplied,
      viesUnavailable,
      viesChecked,
      viesValid,
      viesRawResponse,
    });

    const invoiceRequest = await createOrUpdateInvoiceRequest({
      shop: session.shop,
      cartToken,
      data: {
        cartToken,
        checkoutToken,
        customerId: preparedCustomerGid || customerGid || customerId,
        customerEmail,
        invoiceType,
        countryCode,
        fiscalCode,
        vatNumber: fullVatNumber,
        pec,
        sdi,
        companyName,
        firstName,
        lastName,
        viesChecked,
        viesValid,
        viesRawResponse: viesRawResponse ? JSON.stringify(viesRawResponse) : null,
        reverseCharge,
        taxExemptApplied,
        status: "failed",
        errorMessage: error?.message || "Errore validazione fattura.",
      },
    });

    return responseJson(
      {
        ok: false,
        invoiceRequestId: invoiceRequest.id,
        error: error?.message || "Errore validazione fattura.",
      },
      500,
    );
  }
}

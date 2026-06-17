import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STORE_COUNTRY_CODE = (process.env.STORE_COUNTRY_CODE || "IT").toUpperCase();
const ENABLE_VIES_CHECK = (process.env.ENABLE_VIES_CHECK || "true") === "true";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
  "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

const EU_REVERSE_CHARGE = "EU_REVERSE_CHARGE_EXEMPTION_RULE";

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

  return { countryCode: country, vatNumber: vat };
}

function toCustomerGid(customerId) {
  const raw = clean(customerId);
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

function escapeShopifySearch(value) {
  return clean(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function graphQLErrors(data) {
  const errors = data?.errors;
  if (!errors) return [];
  if (Array.isArray(errors)) return errors.map((error) => error?.message).filter(Boolean);
  return [String(errors)];
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
  const response = await fetch("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ countryCode, vatNumber }),
  });

  if (!response.ok) {
    throw new Error(`VIES request failed with status ${response.status}`);
  }

  return await response.json();
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

  const response = await admin.graphql(mutation, { variables: { metafields } });
  const data = await response.json();
  const topLevelErrors = graphQLErrors(data);
  const errors = data?.data?.metafieldsSet?.userErrors || [];

  if (topLevelErrors.length || errors.length) {
    throw new Error([
      ...topLevelErrors,
      ...errors.map((error) => error.message),
    ].join(" | "));
  }
}

async function findCustomerByEmail(admin, email) {
  const cleanedEmail = cleanEmailLike(email);
  if (!cleanedEmail) return null;

  const query = `#graphql
    query FindCustomerByEmail($query: String!) {
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

  const response = await admin.graphql(query, {
    variables: { query: `email:${escapeShopifySearch(cleanedEmail)}` },
  });

  const data = await response.json();
  const topLevelErrors = graphQLErrors(data);
  if (topLevelErrors.length) {
    throw new Error(topLevelErrors.join(" | "));
  }

  return data?.data?.customers?.nodes?.[0] || null;
}

async function createCustomerByEmail(admin, { email, firstName, lastName, companyName }) {
  const cleanedEmail = cleanEmailLike(email);
  if (!cleanedEmail) return null;

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

  const input = {
    email: cleanedEmail,
    firstName: clean(firstName) || undefined,
    lastName: clean(lastName) || undefined,
    note: clean(companyName)
      ? `Created by Invoice Request / VIES Check for ${clean(companyName)}`
      : "Created by Invoice Request / VIES Check",
  };

  const response = await admin.graphql(mutation, { variables: { input } });
  const data = await response.json();
  const topLevelErrors = graphQLErrors(data);
  const userErrors = data?.data?.customerCreate?.userErrors || [];

  if (topLevelErrors.length) {
    throw new Error(topLevelErrors.join(" | "));
  }

  if (userErrors.length) {
    const message = userErrors.map((error) => error.message).join(" | ");

    // If Shopify says the email already exists, race/fallback to lookup.
    if (/already|taken|exists/i.test(message)) {
      const existing = await findCustomerByEmail(admin, cleanedEmail);
      if (existing?.id) return existing;
    }

    throw new Error(message);
  }

  return data?.data?.customerCreate?.customer || null;
}

async function ensureCustomerForReverseCharge(admin, { customerGid, email, firstName, lastName, companyName }) {
  if (customerGid) {
    return {
      id: customerGid,
      email: cleanEmailLike(email),
      created: false,
      foundByEmail: false,
    };
  }

  const cleanedEmail = cleanEmailLike(email);
  if (!cleanedEmail) {
    throw new Error("Per applicare il reverse charge automatico è obbligatoria l'email aziendale.");
  }

  const existing = await findCustomerByEmail(admin, cleanedEmail);
  if (existing?.id) {
    return {
      ...existing,
      created: false,
      foundByEmail: true,
    };
  }

  const created = await createCustomerByEmail(admin, {
    email: cleanedEmail,
    firstName,
    lastName,
    companyName,
  });

  if (!created?.id) {
    throw new Error("Non sono riuscito a creare il cliente Shopify per applicare il reverse charge.");
  }

  return {
    ...created,
    created: true,
    foundByEmail: true,
  };
}

async function setCustomerTaxExemptFlag(admin, customerGid, taxExempt) {
  const mutation = `#graphql
    mutation SetCustomerTaxExempt($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id taxExempt taxExemptions }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      input: {
        id: customerGid,
        taxExempt: Boolean(taxExempt),
      },
    },
  });

  const data = await response.json();
  const topLevelErrors = graphQLErrors(data);
  const userErrors = data?.data?.customerUpdate?.userErrors || [];

  if (topLevelErrors.length || userErrors.length) {
    throw new Error([
      ...topLevelErrors,
      ...userErrors.map((error) => error.message),
    ].join(" | "));
  }

  return data?.data?.customerUpdate?.customer || null;
}

async function addReverseChargeExemption(admin, customerGid) {
  const mutation = `#graphql
    mutation AddEuReverseCharge($customerId: ID!, $taxExemptions: [TaxExemption!]!) {
      customerAddTaxExemptions(customerId: $customerId, taxExemptions: $taxExemptions) {
        customer { id taxExempt taxExemptions }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      customerId: customerGid,
      taxExemptions: [EU_REVERSE_CHARGE],
    },
  });

  const data = await response.json();
  const topLevelErrors = graphQLErrors(data);
  const userErrors = data?.data?.customerAddTaxExemptions?.userErrors || [];

  if (topLevelErrors.length || userErrors.length) {
    throw new Error([
      ...topLevelErrors,
      ...userErrors.map((error) => error.message),
    ].join(" | "));
  }

  return data?.data?.customerAddTaxExemptions?.customer || null;
}

async function getCustomerTaxDetails(admin, customerGid) {
  const query = `#graphql
    query GetCustomerTaxDetails($id: ID!) {
      customer(id: $id) {
        id
        email
        taxExempt
        taxExemptions
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { id: customerGid } });
  const data = await response.json();
  const topLevelErrors = graphQLErrors(data);

  if (topLevelErrors.length) {
    throw new Error(topLevelErrors.join(" | "));
  }

  return data?.data?.customer || null;
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

  // Shopify checkout only respects reverse charge if the customer is tax exempt.
  // We therefore set the taxExempt flag and also attach the EU reverse charge exemption.
  await setCustomerTaxExemptFlag(admin, customerGid, true);
  await addReverseChargeExemption(admin, customerGid);

  const customer = await getCustomerTaxDetails(admin, customerGid);
  const taxExemptions = customer?.taxExemptions || [];
  const customerTaxExempt = Boolean(customer?.taxExempt);

  const applied =
    customerTaxExempt === true &&
    taxExemptions.includes(EU_REVERSE_CHARGE);

  return {
    applied,
    customerTaxExempt,
    customerTaxExemptions: taxExemptions,
    customerEmail: customer?.email || "",
    error: applied ? "" : "EU reverse charge exemption was not confirmed on customer.",
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
      return await prisma.invoiceRequest.update({
        where: { id: existing.id },
        data,
      });
    }
  }

  return await prisma.invoiceRequest.create({
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

  const body = await readJson(request);

  const invoiceType = clean(body.invoiceType);
  const cartToken = clean(body.cartToken);
  const checkoutToken = clean(body.checkoutToken);
  const customerId = clean(body.customerId);
  const originalCustomerGid = toCustomerGid(customerId);
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
    return responseJson({ ok: false, error: "Tipo fattura non valido." }, 400);
  }

  if (invoiceType === "company" && (!countryCode || !vatNumber)) {
    return responseJson({ ok: false, error: "Paese e partita IVA sono obbligatori." }, 400);
  }

  let customerGid = originalCustomerGid;
  let preparedCustomer = null;
  let viesChecked = false;
  let viesValid = null;
  let viesRawResponse = null;
  let reverseCharge = false;
  let taxExemptApplied = false;
  let taxExemptCustomerPrepared = false;
  let requiresLoginForTaxExemption = false;
  let customerTaxExempt = false;
  let customerTaxExemptions = [];

  try {
    const shouldCheckVies =
      invoiceType === "company" &&
      ENABLE_VIES_CHECK &&
      EU_COUNTRIES.has(countryCode) &&
      countryCode !== STORE_COUNTRY_CODE;

    if (shouldCheckVies) {
      viesChecked = true;
      viesRawResponse = await checkVies(countryCode, vatNumber);
      viesValid = Boolean(viesRawResponse?.valid);
      reverseCharge = viesValid === true;

      if (!viesValid) {
        throw new Error("Partita IVA non valida su VIES.");
      }

      if (reverseCharge) {
        preparedCustomer = await ensureCustomerForReverseCharge(admin, {
          customerGid,
          email: customerEmail,
          firstName,
          lastName,
          companyName,
        });

        customerGid = preparedCustomer?.id || customerGid;

        const taxExemptResult = await applyReverseCharge(admin, customerGid);
        taxExemptApplied = Boolean(taxExemptResult.applied);
        taxExemptCustomerPrepared = taxExemptApplied;
        customerTaxExempt = Boolean(taxExemptResult.customerTaxExempt);
        customerTaxExemptions = taxExemptResult.customerTaxExemptions || [];

        if (!taxExemptApplied) {
          throw new Error(
            taxExemptResult.error ||
              "VAT number is valid, but VAT exemption could not be applied to the customer."
          );
        }
      }
    }

    if (customerGid) {
      await setCustomerMetafields(admin, customerGid, {
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
        tax_exempt_applied: String(taxExemptApplied),
      });
    }

    const invoiceRequest = await createOrUpdateInvoiceRequest({
      shop: session.shop,
      cartToken,
      data: {
        cartToken,
        checkoutToken,
        customerId: customerGid || customerId,
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
        status: invoiceType === "private" ? "registered" : "validated",
        errorMessage: null,
      },
    });

    return responseJson({
      ok: true,
      invoiceRequestId: invoiceRequest.id,
      invoiceType,
      vatNumber: fullVatNumber,
      customerEmail,
      customerId: customerGid || customerId,
      customerCreated: Boolean(preparedCustomer?.created),
      customerFoundByEmail: Boolean(preparedCustomer?.foundByEmail),
      viesChecked,
      viesValid,
      reverseCharge,
      taxExemptApplied,
      taxExemptCustomerPrepared,
      customerTaxExempt,
      customerTaxExemptions,
      requiresLoginForTaxExemption,
      mustUseSameEmailAtCheckout: Boolean(reverseCharge && customerEmail),
    });
  } catch (error) {
    const invoiceRequest = await createOrUpdateInvoiceRequest({
      shop: session.shop,
      cartToken,
      data: {
        cartToken,
        checkoutToken,
        customerId: customerGid || customerId,
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

    return responseJson({
      ok: false,
      invoiceRequestId: invoiceRequest.id,
      error: error?.message || "Errore validazione fattura.",
      reverseCharge,
      taxExemptApplied,
      requiresLoginForTaxExemption,
    }, 500);
  }
}

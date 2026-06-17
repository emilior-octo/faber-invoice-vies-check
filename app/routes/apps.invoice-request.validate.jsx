import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STORE_COUNTRY_CODE = (process.env.STORE_COUNTRY_CODE || "IT").toUpperCase();
const ENABLE_VIES_CHECK = (process.env.ENABLE_VIES_CHECK || "true") === "true";

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

  return { countryCode: country, vatNumber: vat };
}

function toCustomerGid(customerId) {
  const raw = clean(customerId);
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

function stringifyError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return error.message || JSON.stringify(error);
}

function isViesTechnicalFailure(viesResponse) {
  if (!viesResponse || typeof viesResponse !== "object") return false;

  if (viesResponse.actionSucceed === false) return true;
  if (Array.isArray(viesResponse.errorWrappers) && viesResponse.errorWrappers.length > 0) return true;
  if (viesResponse.error || viesResponse.faultstring || viesResponse.faultCode) return true;

  return false;
}

function getViesErrorMessage(viesResponse) {
  const wrappers = viesResponse?.errorWrappers || [];
  if (Array.isArray(wrappers) && wrappers.length) {
    return wrappers
      .map((wrapper) => wrapper?.message || wrapper?.error || wrapper?.code || JSON.stringify(wrapper))
      .filter(Boolean)
      .join(" | ");
  }

  return viesResponse?.error || viesResponse?.faultstring || viesResponse?.faultCode || "VIES unavailable";
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
  const payload = {
    countryCode: normalized.countryCode,
    vatNumber: normalized.vatNumber,
  };

  console.log("[Invoice Request] VIES request payload", payload);

  const response = await fetch("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    const text = await response.text().catch(() => "");
    data = {
      actionSucceed: false,
      error: `Unable to parse VIES response: ${stringifyError(error)}`,
      raw: text,
    };
  }

  const enriched = {
    ...data,
    _requestPayload: payload,
    _httpStatus: response.status,
    _httpOk: response.ok,
  };

  console.log("[Invoice Request] VIES response", {
    status: response.status,
    ok: response.ok,
    payload,
    data,
  });

  if (!response.ok) {
    return {
      ...enriched,
      actionSucceed: false,
      error: `VIES request failed with HTTP status ${response.status}`,
    };
  }

  return enriched;
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
  const errors = data?.data?.metafieldsSet?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }
}

async function findCustomerByEmail(admin, email) {
  const cleanEmail = cleanEmailLike(email);
  if (!cleanEmail) return "";

  const query = `#graphql
    query FindCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node { id email }
        }
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: { query: `email:${cleanEmail}` },
  });

  const data = await response.json();
  const customer = data?.data?.customers?.edges?.[0]?.node;

  return customer?.id || "";
}

async function createCustomerForInvoice(admin, { email, firstName, lastName, companyName }) {
  const cleanEmail = cleanEmailLike(email);
  if (!cleanEmail) return "";

  const mutation = `#graphql
    mutation CreateInvoiceCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id email }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      input: {
        email: cleanEmail,
        firstName: clean(firstName) || undefined,
        lastName: clean(lastName) || clean(companyName) || undefined,
        tags: ["invoice_request", "eu_reverse_charge_candidate"],
      },
    },
  });

  const data = await response.json();
  const errors = data?.data?.customerCreate?.userErrors || [];

  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");
    console.warn("[Invoice Request] customerCreate failed", { email: cleanEmail, errors });

    const existing = await findCustomerByEmail(admin, cleanEmail);
    if (existing) return existing;

    throw new Error(message);
  }

  return data?.data?.customerCreate?.customer?.id || "";
}

async function resolveCustomerForTaxExemption(admin, { customerGid, email, firstName, lastName, companyName }) {
  if (customerGid) return customerGid;

  const found = await findCustomerByEmail(admin, email);
  if (found) return found;

  return await createCustomerForInvoice(admin, { email, firstName, lastName, companyName });
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
    mutation ApplyEuReverseCharge($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer {
          id
          taxExempt
          taxExemptions
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      input: {
        id: customerGid,
        taxExempt: true,
        taxExemptions: ["EU_REVERSE_CHARGE_EXEMPTION_RULE"],
      },
    },
  });

  const data = await response.json();
  const errors = data?.data?.customerUpdate?.userErrors || [];

  if (errors.length) {
    console.error("[Invoice Request] customerUpdate tax exemption failed", {
      customerGid,
      errors,
      data,
    });

    throw new Error(errors.map((error) => error.message).join(" | "));
  }

  const customer = data?.data?.customerUpdate?.customer;
  const taxExemptions = customer?.taxExemptions || [];
  const customerTaxExempt = Boolean(customer?.taxExempt);

  const applied =
    customerTaxExempt === true &&
    taxExemptions.includes("EU_REVERSE_CHARGE_EXEMPTION_RULE");

  console.log("[Invoice Request] customer tax exemption result", {
    customerGid,
    applied,
    customerTaxExempt,
    taxExemptions,
  });

  return {
    applied,
    customerTaxExempt,
    customerTaxExemptions: taxExemptions,
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

  const url = new URL(request.url);
  const proxyCustomerId = clean(url.searchParams.get("logged_in_customer_id"));
  const proxyCustomerGid = toCustomerGid(proxyCustomerId);

  const body = await readJson(request);

  const invoiceType = clean(body.invoiceType);
  const cartToken = clean(body.cartToken);
  const checkoutToken = clean(body.checkoutToken);
  const bodyCustomerId = clean(body.customerId);
  const originalCustomerGid = toCustomerGid(bodyCustomerId) || proxyCustomerGid;
  const customerEmail = cleanEmailLike(body.customerEmail || body.email);

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
  let viesChecked = false;
  let viesValid = null;
  let viesRawResponse = null;
  let reverseCharge = false;
  let taxExemptApplied = false;
  let requiresLoginForTaxExemption = false;
  let customerPreparedByEmail = false;
  let pendingManualReview = false;
  let noticeMessage = "";

  try {
    const shouldCheckVies =
      invoiceType === "company" &&
      ENABLE_VIES_CHECK &&
      EU_COUNTRIES.has(countryCode) &&
      countryCode !== STORE_COUNTRY_CODE;

    if (shouldCheckVies) {
      viesChecked = true;
      viesRawResponse = await checkVies(countryCode, vatNumber);

      console.log("[Invoice Request] VIES result", {
        inputCountryCode: countryCode,
        inputVatNumber: vatNumber,
        fullVatNumber,
        viesPayload: viesRawResponse?._requestPayload,
        valid: viesRawResponse?.valid,
        actionSucceed: viesRawResponse?.actionSucceed,
        response: viesRawResponse,
      });

      if (isViesTechnicalFailure(viesRawResponse)) {
        pendingManualReview = true;
        viesValid = null;
        reverseCharge = false;
        taxExemptApplied = false;
        noticeMessage = `VIES temporaneamente non disponibile o non conclusivo (${getViesErrorMessage(viesRawResponse)}). Richiesta salvata per verifica manuale.`;
      } else {
        viesValid = Boolean(viesRawResponse?.valid);
        reverseCharge = viesValid === true;

        if (!viesValid) {
          const invoiceRequest = await createOrUpdateInvoiceRequest({
            shop: session.shop,
            cartToken,
            data: {
              cartToken,
              checkoutToken,
              customerId: customerGid || bodyCustomerId,
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
              reverseCharge: false,
              taxExemptApplied: false,
              status: "failed",
              errorMessage: `Partita IVA non valida su VIES (${fullVatNumber}).`,
            },
          });

          return responseJson({
            ok: false,
            invoiceRequestId: invoiceRequest.id,
            error: `Partita IVA non valida su VIES (${fullVatNumber}).`,
            invoiceType,
            vatNumber: fullVatNumber,
            viesChecked,
            viesValid,
            reverseCharge: false,
            taxExemptApplied: false,
          }, 400);
        }

        if (reverseCharge) {
          customerGid = await resolveCustomerForTaxExemption(admin, {
            customerGid,
            email: customerEmail,
            firstName,
            lastName,
            companyName,
          });

          customerPreparedByEmail = !originalCustomerGid && Boolean(customerGid);

          if (customerGid) {
            const taxExemptResult = await applyReverseCharge(admin, customerGid);
            taxExemptApplied = Boolean(taxExemptResult.applied);

            if (!taxExemptApplied) {
              pendingManualReview = true;
              noticeMessage = taxExemptResult.error || "VAT valido, ma esenzione non confermata sul customer.";
            }
          } else {
            requiresLoginForTaxExemption = true;
            pendingManualReview = true;
            noticeMessage = "VAT valido, ma serve email/login per preparare il customer tax exempt.";
          }
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

    const status = pendingManualReview
      ? "pending_review"
      : invoiceType === "private"
        ? "registered"
        : "validated";

    const invoiceRequest = await createOrUpdateInvoiceRequest({
      shop: session.shop,
      cartToken,
      data: {
        cartToken,
        checkoutToken,
        customerId: customerGid || bodyCustomerId || proxyCustomerGid,
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
        status,
        errorMessage: noticeMessage || null,
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
      requiresLoginForTaxExemption,
      customerPreparedByEmail,
      pendingManualReview,
      message: noticeMessage,
    });
  } catch (error) {
    console.error("[Invoice Request] validate failed", {
      message: error?.message,
      stack: error?.stack,
      invoiceType,
      countryCode,
      vatNumber: fullVatNumber,
      customerId: customerGid || bodyCustomerId,
      proxyCustomerId,
      originalCustomerGid,
      customerEmail,
      viesRawResponse,
      reverseCharge,
      taxExemptApplied,
      viesChecked,
      viesValid,
    });

    const invoiceRequest = await createOrUpdateInvoiceRequest({
      shop: session.shop,
      cartToken,
      data: {
        cartToken,
        checkoutToken,
        customerId: customerGid || bodyCustomerId || proxyCustomerGid,
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
    }, 500);
  }
}

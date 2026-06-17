import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STORE_COUNTRY_CODE = (process.env.STORE_COUNTRY_CODE || "IT").toUpperCase();
const ENABLE_VIES_CHECK = (process.env.ENABLE_VIES_CHECK || "true") === "true";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
  "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

const EU_REVERSE_CHARGE_EXEMPTION = "EU_REVERSE_CHARGE_EXEMPTION_RULE";

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
  const errors = data?.data?.metafieldsSet?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }
}

async function readCustomerTaxState(admin, customerGid) {
  if (!customerGid) {
    return {
      customerTaxExempt: false,
      customerTaxExemptions: [],
    };
  }

  const query = `#graphql
    query ReadCustomerTaxState($id: ID!) {
      customer(id: $id) {
        id
        taxExempt
        taxExemptions
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: { id: customerGid },
  });

  const data = await response.json();
  const customer = data?.data?.customer;

  return {
    customerTaxExempt: Boolean(customer?.taxExempt),
    customerTaxExemptions: customer?.taxExemptions || [],
  };
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
        taxExemptions: [EU_REVERSE_CHARGE_EXEMPTION],
      },
    },
  });

  const data = await response.json();
  const errors = data?.data?.customerUpdate?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }

  const customerFromMutation = data?.data?.customerUpdate?.customer;
  let customerTaxExempt = Boolean(customerFromMutation?.taxExempt);
  let customerTaxExemptions = customerFromMutation?.taxExemptions || [];

  // Re-read after update: this avoids trusting only the mutation payload and gives us
  // the real customer tax state before the customer is sent to checkout.
  const confirmed = await readCustomerTaxState(admin, customerGid);
  customerTaxExempt = confirmed.customerTaxExempt;
  customerTaxExemptions = confirmed.customerTaxExemptions;

  const applied =
    customerTaxExempt === true &&
    customerTaxExemptions.includes(EU_REVERSE_CHARGE_EXEMPTION);

  return {
    applied,
    customerTaxExempt,
    customerTaxExemptions,
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
    return responseJson({ ok: false, error: "Tipo fattura non valido." }, 400);
  }

  if (invoiceType === "company" && (!countryCode || !vatNumber)) {
    return responseJson({ ok: false, error: "Paese e partita IVA sono obbligatori." }, 400);
  }

  let viesChecked = false;
  let viesValid = null;
  let viesRawResponse = null;
  let reverseCharge = false;
  let taxExemptApplied = false;
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

      if (reverseCharge && customerGid) {
        const taxExemptResult = await applyReverseCharge(admin, customerGid);
        taxExemptApplied = Boolean(taxExemptResult.applied);
        customerTaxExempt = Boolean(taxExemptResult.customerTaxExempt);
        customerTaxExemptions = taxExemptResult.customerTaxExemptions || [];

        if (!taxExemptApplied) {
          throw new Error(
            taxExemptResult.error ||
              "VAT number is valid, but VAT exemption could not be applied to the customer."
          );
        }
      } else if (reverseCharge && !customerGid) {
        requiresLoginForTaxExemption = true;
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
        customer_tax_exempt: String(customerTaxExempt),
        customer_tax_exemptions: customerTaxExemptions.join(","),
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
      viesChecked,
      viesValid,
      reverseCharge,
      taxExemptApplied,
      customerTaxExempt,
      customerTaxExemptions,
      requiresLoginForTaxExemption,
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
      invoiceType,
      vatNumber: fullVatNumber,
      viesChecked,
      viesValid,
      reverseCharge,
      taxExemptApplied,
      customerTaxExempt,
      customerTaxExemptions,
      requiresLoginForTaxExemption,
    }, 500);
  }
}

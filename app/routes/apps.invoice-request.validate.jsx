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

  return { countryCode: country, vatNumber: vat };
}

function normalizeFullVat(value) {
  return cleanUpper(value).replace(/[\s.\-_/]/g, "");
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

  const client = await soap.createClientAsync(VIES_WSDL);
  const [result] = await client.checkVatAsync({
    countryCode: normalized.countryCode,
    vatNumber: normalized.vatNumber,
  });

  const response = {
    valid: Boolean(result?.valid),
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
            viesRawResponse: JSON.stringify(viesRawResponse),
            reverseCharge: false,
            taxExemptApplied: false,
            status: "failed",
            errorMessage: `Partita IVA non valida su VIES (${fullVatNumber}). Reverse charge non applicato.`,
          },
        });

        return responseJson(
          {
            ok: false,
            invoiceRequestId: invoiceRequest.id,
            invoiceType,
            vatNumber: fullVatNumber,
            viesChecked,
            viesValid,
            reverseCharge: false,
            taxExemptApplied: false,
            error: `Partita IVA non valida su VIES (${fullVatNumber}). Reverse charge non applicato.`,
          },
          400,
        );
      }

      if (reverseCharge && customerGid) {
        const taxExemptResult = await applyReverseCharge(admin, customerGid);
        taxExemptApplied = Boolean(taxExemptResult.applied);
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
        errorMessage: taxExemptApplied || !reverseCharge ? null : "VIES valido, ma reverse charge non confermato sul cliente Shopify.",
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
    });
  } catch (error) {
    console.error("[Invoice Request] validate failed", {
      message: error?.message,
      invoiceType,
      countryCode,
      vatNumber: fullVatNumber,
      customerId: customerGid || customerId,
      proxyCustomerId,
      reverseCharge,
      taxExemptApplied,
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

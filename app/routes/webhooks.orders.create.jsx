import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function clean(value) {
  return String(value || "").trim();
}

function getPayloadAttributes(payload) {
  return [
    ...(Array.isArray(payload?.note_attributes) ? payload.note_attributes : []),
    ...(Array.isArray(payload?.noteAttributes) ? payload.noteAttributes : []),
    ...(Array.isArray(payload?.attributes) ? payload.attributes : []),
    ...(Array.isArray(payload?.cart_attributes) ? payload.cart_attributes : []),
    ...(Array.isArray(payload?.cartAttributes) ? payload.cartAttributes : []),
  ];
}

function getAttribute(payload, key) {
  const attrs = getPayloadAttributes(payload);
  const found = attrs.find((item) => item?.name === key || item?.key === key);

  if (found?.value !== undefined && found?.value !== null) {
    return clean(found.value);
  }

  if (payload?.[key] !== undefined && payload?.[key] !== null) {
    return clean(payload[key]);
  }

  return "";
}

function getFirstAttribute(payload, keys) {
  for (const key of keys) {
    const value = getAttribute(payload, key);
    if (value) return value;
  }

  return "";
}

function optionalBoolean(value) {
  const normalized = clean(value).toLowerCase();

  if (!normalized) return undefined;
  if (["true", "1", "yes", "y", "si", "sì"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;

  return undefined;
}

function getCustomerEmail(payload) {
  return clean(
    payload?.email ||
      payload?.contact_email ||
      payload?.contactEmail ||
      payload?.customer?.email ||
      payload?.billing_address?.email ||
      payload?.billingAddress?.email
  ).toLowerCase();
}

function getCustomerId(payload) {
  const rawId = payload?.customer?.id || payload?.customer?.admin_graphql_api_id || payload?.customer?.adminGraphqlApiId;
  return rawId ? String(rawId) : "";
}

function getPayloadFirstName(payload) {
  return clean(
    payload?.billing_address?.first_name ||
      payload?.billingAddress?.firstName ||
      payload?.shipping_address?.first_name ||
      payload?.shippingAddress?.firstName ||
      payload?.customer?.first_name ||
      payload?.customer?.firstName
  );
}

function getPayloadLastName(payload) {
  return clean(
    payload?.billing_address?.last_name ||
      payload?.billingAddress?.lastName ||
      payload?.shipping_address?.last_name ||
      payload?.shippingAddress?.lastName ||
      payload?.customer?.last_name ||
      payload?.customer?.lastName
  );
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function makePairsFromPayloadAttributes(payload) {
  return getPayloadAttributes(payload).map((item) => ({
    key: clean(item?.name || item?.key),
    value: clean(item?.value),
  }));
}

function makePairsFromMetafields(nodes) {
  return (nodes || []).flatMap((node) => {
    const namespace = clean(node?.namespace);
    const key = clean(node?.key);
    const value = clean(node?.value);

    return [
      { key, value },
      { key: namespace && key ? `${namespace}.${key}` : key, value },
    ];
  });
}

function getPairValue(pairs, acceptedKeys) {
  const normalizedAcceptedKeys = acceptedKeys.map(normalizeKey).filter(Boolean);

  for (const pair of pairs || []) {
    const normalizedPairKey = normalizeKey(pair?.key);
    const value = clean(pair?.value);

    if (!normalizedPairKey || !value) continue;

    if (
      normalizedAcceptedKeys.some(
        (acceptedKey) =>
          normalizedPairKey === acceptedKey ||
          normalizedPairKey.includes(acceptedKey) ||
          acceptedKey.includes(normalizedPairKey)
      )
    ) {
      return value;
    }
  }

  return "";
}

function buildWhere({ shop, invoiceRequestId, cartToken }) {
  const whereItems = [];

  if (invoiceRequestId) whereItems.push({ id: invoiceRequestId });
  if (cartToken) whereItems.push({ cartToken });

  if (!whereItems.length) return null;

  return { shop, OR: whereItems };
}

async function syncInvoiceRequestWithOrder({
  shop,
  invoiceRequestId,
  cartToken,
  orderNumericId,
  orderName,
  customerId,
  customerEmail,
  firstName,
  lastName,
  invoiceType,
  fiscalCode,
  vatNumber,
  invoiceCountryCode,
  pec,
  sdi,
  companyName,
  viesChecked,
  viesValid,
  reverseCharge,
}) {
  const where = buildWhere({ shop, invoiceRequestId, cartToken });

  if (!where) {
    return { count: 0 };
  }

  return await prisma.invoiceRequest.updateMany({
    where,
    data: {
      orderId: orderNumericId || undefined,
      orderName: orderName || undefined,
      customerId: customerId || undefined,
      customerEmail: customerEmail || undefined,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      invoiceType: invoiceType || undefined,
      fiscalCode: fiscalCode || undefined,
      vatNumber: vatNumber || undefined,
      countryCode: invoiceCountryCode || undefined,
      pec: pec || undefined,
      sdi: sdi || undefined,
      companyName: companyName || undefined,
      viesChecked: optionalBoolean(viesChecked),
      viesValid: optionalBoolean(viesValid),
      reverseCharge: optionalBoolean(reverseCharge),
      status: "order_created",
      errorMessage: null,
    },
  });
}

async function fetchNativeOrderFiscalData(admin, orderGid) {
  const query = `#graphql
    query InvoiceNativeOrderFiscalData($id: ID!) {
      order(id: $id) {
        id
        legacyResourceId
        name
        email
        customAttributes {
          key
          value
        }
        billingAddress {
          firstName
          lastName
          company
          address1
          address2
          city
          zip
          provinceCode
          countryCodeV2
          phone
        }
        shippingAddress {
          firstName
          lastName
          company
          address1
          address2
          city
          zip
          provinceCode
          countryCodeV2
          phone
        }
        customer {
          id
          legacyResourceId
          email
          firstName
          lastName
          metafields(first: 50) {
            nodes {
              namespace
              key
              value
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { id: orderGid } });
  const data = await response.json();

  if (data?.errors?.length) {
    throw new Error(data.errors.map((error) => error.message).join(" | "));
  }

  const order = data?.data?.order;

  if (!order) {
    throw new Error("Order not found through Admin GraphQL");
  }

  const billingAddress = order.billingAddress || {};
  const shippingAddress = order.shippingAddress || {};
  const customer = order.customer || {};
  const customerMetafieldPairs = makePairsFromMetafields(customer.metafields?.nodes || []);
  const orderAttributePairs = (order.customAttributes || []).map((item) => ({
    key: clean(item?.key),
    value: clean(item?.value),
  }));

  const allPairs = [...orderAttributePairs, ...customerMetafieldPairs];

  const fiscalCode = getPairValue(allPairs, [
    "fiscal_code",
    "fiscalCode",
    "codice_fiscale",
    "codice fiscale",
    "codiceFiscale",
    "tax_code",
    "taxCode",
    "cf",
  ]);

  const pec = getPairValue(allPairs, [
    "pec",
    "certified_email",
    "certifiedEmail",
    "posta certificata",
    "posta_elettronica_certificata",
  ]);

  const sdi = getPairValue(allPairs, [
    "sdi",
    "codice_sdi",
    "codice sdi",
    "recipient_code",
    "recipientCode",
    "codice_destinatario",
    "codice destinatario",
  ]);

  const vatNumber = getPairValue(allPairs, [
    "vat_number",
    "vatNumber",
    "partita_iva",
    "partita iva",
    "piva",
    "p_iva",
    "tax_id",
    "taxId",
  ]);

  return {
    orderName: clean(order.name),
    orderNumericId: order.legacyResourceId ? String(order.legacyResourceId) : "",
    customerId: customer.legacyResourceId ? String(customer.legacyResourceId) : clean(customer.id),
    customerEmail: clean(order.email || customer.email).toLowerCase(),
    firstName: clean(billingAddress.firstName || shippingAddress.firstName || customer.firstName),
    lastName: clean(billingAddress.lastName || shippingAddress.lastName || customer.lastName),
    fiscalCode,
    pec,
    sdi,
    vatNumber,
    companyName: clean(billingAddress.company || shippingAddress.company),
    countryCode: clean(billingAddress.countryCodeV2 || shippingAddress.countryCodeV2),
  };
}

async function setOrderMetafields(admin, orderGid, fields) {
  const metafields = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({
      ownerId: orderGid,
      namespace: "custom",
      key,
      type: "single_line_text_field",
      value: String(value),
    }));

  if (!metafields.length) return;

  const mutation = `#graphql
    mutation SetOrderInvoiceMetafields($metafields: [MetafieldsSetInput!]!) {
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

async function addOrderTags(admin, orderGid, tags) {
  const cleanTags = Array.from(new Set(tags.filter(Boolean)));
  if (!cleanTags.length) return;

  const mutation = `#graphql
    mutation AddOrderInvoiceTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: { id: orderGid, tags: cleanTags },
  });

  const data = await response.json();
  const errors = data?.data?.tagsAdd?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }
}

export async function action({ request }) {
  const { topic, shop, admin, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Wrong topic", { status: 400 });
  }

  const invoiceRequested = getAttribute(payload, "invoice_requested");

  if (invoiceRequested !== "true") {
    return new Response("No invoice requested", { status: 200 });
  }

  const orderNumericId = payload?.id ? String(payload.id) : "";
  const orderGid = payload?.admin_graphql_api_id || `gid://shopify/Order/${orderNumericId}`;
  const orderName = payload?.name || "";
  const cartToken = payload?.cart_token || payload?.cartToken || "";

  const invoiceRequestId = getAttribute(payload, "invoice_request_id");
  const invoiceType = getAttribute(payload, "invoice_type");
  const fiscalCodeFromAttributes = getFirstAttribute(payload, [
    "fiscal_code",
    "fiscalCode",
    "codice_fiscale",
    "codice fiscale",
    "Codice Fiscale",
    "cf",
    "tax_code",
    "taxCode",
  ]);
  const vatNumberFromAttributes = getFirstAttribute(payload, ["vat_number", "vatNumber", "partita_iva", "partita iva", "piva"]);
  const invoiceCountryCode = getFirstAttribute(payload, ["invoice_country_code", "country_code"]);
  const pecFromAttributes = getFirstAttribute(payload, ["pec", "PEC", "certified_email", "certifiedEmail"]);
  const sdiFromAttributes = getFirstAttribute(payload, ["sdi", "SDI", "codice_sdi", "recipient_code"]);
  const viesChecked = getAttribute(payload, "vies_checked");
  const viesValid = getAttribute(payload, "vies_valid");
  const reverseCharge = getAttribute(payload, "reverse_charge");
  const companyNameFromAttributes = getAttribute(payload, "company_name");
  const customerEmailFromPayload = getCustomerEmail(payload);
  const customerIdFromPayload = getCustomerId(payload);
  const firstNameFromPayload = getPayloadFirstName(payload);
  const lastNameFromPayload = getPayloadLastName(payload);

  let enrichedFiscalData = null;

  try {
    enrichedFiscalData = await fetchNativeOrderFiscalData(admin, orderGid);
  } catch (error) {
    console.log("[orders/create] Native fiscal data enrichment skipped", {
      shop,
      orderGid,
      invoiceRequestId,
      error: error?.message || String(error),
    });
  }

  const fiscalCode = fiscalCodeFromAttributes || enrichedFiscalData?.fiscalCode || "";
  const vatNumber = vatNumberFromAttributes || enrichedFiscalData?.vatNumber || "";
  const pec = pecFromAttributes || enrichedFiscalData?.pec || "";
  const sdi = sdiFromAttributes || enrichedFiscalData?.sdi || "";
  const companyName = companyNameFromAttributes || enrichedFiscalData?.companyName || "";
  const customerEmail = customerEmailFromPayload || enrichedFiscalData?.customerEmail || "";
  const customerId = customerIdFromPayload || enrichedFiscalData?.customerId || "";
  const firstName = firstNameFromPayload || enrichedFiscalData?.firstName || "";
  const lastName = lastNameFromPayload || enrichedFiscalData?.lastName || "";
  const finalOrderNumericId = orderNumericId || enrichedFiscalData?.orderNumericId || "";
  const finalOrderName = orderName || enrichedFiscalData?.orderName || "";
  const finalCountryCode = invoiceCountryCode || enrichedFiscalData?.countryCode || "";

  let invoiceSyncCount = 0;

  try {
    const syncResult = await syncInvoiceRequestWithOrder({
      shop,
      invoiceRequestId,
      cartToken,
      orderNumericId: finalOrderNumericId,
      orderName: finalOrderName,
      customerId,
      customerEmail,
      firstName,
      lastName,
      invoiceType,
      fiscalCode,
      vatNumber,
      invoiceCountryCode: finalCountryCode,
      pec,
      sdi,
      companyName,
      viesChecked,
      viesValid,
      reverseCharge,
    });

    invoiceSyncCount = syncResult?.count || 0;
  } catch (error) {
    return new Response(error?.message || "Invoice request DB sync failed", { status: 500 });
  }

  try {
    await setOrderMetafields(admin, orderGid, {
      invoice_requested: "true",
      invoice_type: invoiceType,
      fiscal_code: fiscalCode,
      vat_number: vatNumber,
      invoice_country_code: finalCountryCode,
      pec,
      sdi,
      company_name: companyName,
      vies_checked: viesChecked,
      vies_valid: viesValid,
      reverse_charge: reverseCharge,
      invoice_request_id: invoiceRequestId,
    });

    await addOrderTags(admin, orderGid, [
      "invoice_requested",
      invoiceType === "private" ? "invoice_private" : "",
      invoiceType === "company" ? "invoice_company" : "",
      viesValid === "true" ? "vies_valid" : "",
      reverseCharge === "true" ? "reverse_charge" : "",
    ]);

    return new Response(`OK - invoice synced (${invoiceSyncCount})`, { status: 200 });
  } catch (error) {
    const where = buildWhere({ shop, invoiceRequestId, cartToken });

    if (where) {
      await prisma.invoiceRequest.updateMany({
        where,
        data: {
          errorMessage: `Order linked, but order metafields/tags failed: ${error?.message || "Unknown error"}`,
        },
      });
    }

    return new Response(`OK - invoice synced (${invoiceSyncCount}), order decoration failed`, {
      status: 200,
    });
  }
}

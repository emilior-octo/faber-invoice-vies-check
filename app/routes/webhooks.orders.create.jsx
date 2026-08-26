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

function formatAddressLine(parts) {
  return parts.map(clean).filter(Boolean).join(" ");
}

function formatBillingAddress(address) {
  if (!address) return "";

  const lines = [
    formatAddressLine([address.firstName, address.lastName]),
    clean(address.company),
    clean(address.address1),
    clean(address.address2),
    formatAddressLine([address.zip, address.city, address.provinceCode]),
    clean(address.countryCodeV2),
    clean(address.phone) ? `Phone: ${clean(address.phone)}` : "",
  ].filter(Boolean);

  return lines.length ? `Billing address:\n${lines.join("\n")}` : "";
}

function formatMoneyValue(amount, currencyCode) {
  const cleanAmount = clean(amount);
  const cleanCurrency = clean(currencyCode);

  if (!cleanAmount) return "";

  const numeric = Number(cleanAmount);
  const value = Number.isFinite(numeric) ? numeric.toFixed(2) : cleanAmount;

  return cleanCurrency ? `${value} ${cleanCurrency}` : value;
}

function getShopMoney(moneySet) {
  return moneySet?.shopMoney || moneySet?.presentmentMoney || null;
}

function formatOrderItemLine(item) {
  if (!item) return "";

  const sku = clean(item.sku || item.variant?.sku);
  const title = clean(item.title || item.product?.title || item.name);
  const variantTitle = clean(item.variantTitle || item.variant?.title || item.variant_title);
  const quantity = clean(item.quantity);

  const unitMoney = getShopMoney(item.originalUnitPriceSet || item.discountedUnitPriceSet || item.priceSet);
  const totalMoney = getShopMoney(item.discountedTotalSet || item.originalTotalSet || item.totalDiscountSet);

  const unitPrice = formatMoneyValue(unitMoney?.amount || item.price, unitMoney?.currencyCode || item.currency);
  const totalPrice = formatMoneyValue(totalMoney?.amount || item.line_price || item.price, totalMoney?.currencyCode || item.currency);

  const taxInfo = Array.isArray(item.taxLines || item.tax_lines) && (item.taxLines || item.tax_lines).length
    ? ` | Tax: ${(item.taxLines || item.tax_lines)
        .map((taxLine) => {
          const rate = taxLine.ratePercentage !== undefined && taxLine.ratePercentage !== null
            ? `${taxLine.ratePercentage}%`
            : taxLine.rate !== undefined && taxLine.rate !== null
              ? `${Number(taxLine.rate) * 100}%`
              : "";
          const priceMoney = getShopMoney(taxLine.priceSet);
          const price = formatMoneyValue(priceMoney?.amount || taxLine.price, priceMoney?.currencyCode || item.currency);
          return [clean(taxLine.title), rate, price].filter(Boolean).join(" ");
        })
        .filter(Boolean)
        .join(", ")}`
    : "";

  const pieces = [
    sku ? `${sku}` : "SKU —",
    title || "Prodotto senza titolo",
    variantTitle && variantTitle !== "Default Title" ? variantTitle : "",
    quantity ? `Qty: ${quantity}` : "",
    unitPrice ? `Unit: ${unitPrice}` : "",
    totalPrice ? `Total: ${totalPrice}` : "",
  ].filter(Boolean);

  return `- ${pieces.join(" | ")}${taxInfo}`;
}

function formatOrderItems(items) {
  const lines = (items || []).map(formatOrderItemLine).filter(Boolean);

  return lines.length ? `Order items:\n${lines.join("\n")}` : "";
}
function formatPayloadOrderItems(payload) {
  const items = Array.isArray(payload?.line_items)
    ? payload.line_items
    : Array.isArray(payload?.lineItems)
      ? payload.lineItems
      : [];

  return formatOrderItems(items);
}

function getMoneyAmount(value) {
  if (!value) return "";

  if (typeof value === "string" || typeof value === "number") {
    return clean(value);
  }

  return clean(
    value?.shop_money?.amount ||
      value?.shopMoney?.amount ||
      value?.presentment_money?.amount ||
      value?.presentmentMoney?.amount ||
      value?.amount
  );
}

function getMoneyCurrency(value, fallbackCurrency) {
  if (!value || typeof value === "string" || typeof value === "number") {
    return clean(fallbackCurrency);
  }

  return clean(
    value?.shop_money?.currency_code ||
      value?.shop_money?.currencyCode ||
      value?.shopMoney?.currencyCode ||
      value?.presentment_money?.currency_code ||
      value?.presentmentMoney?.currencyCode ||
      value?.currency_code ||
      value?.currencyCode ||
      fallbackCurrency
  );
}

function firstMoney(payload, candidates) {
  for (const candidate of candidates) {
    const value = candidate();
    const amount = getMoneyAmount(value);
    if (amount) {
      return {
        amount,
        currency: getMoneyCurrency(value, payload?.currency || payload?.currencyCode || payload?.presentment_currency || payload?.presentmentCurrency),
      };
    }
  }

  return { amount: "", currency: clean(payload?.currency || payload?.currencyCode || payload?.presentment_currency || payload?.presentmentCurrency) };
}

function formatOrderTotals(payload) {
  const subtotal = firstMoney(payload, [
    () => payload?.current_subtotal_price_set,
    () => payload?.subtotal_price_set,
    () => payload?.current_subtotal_price,
    () => payload?.subtotal_price,
  ]);

  const shipping = firstMoney(payload, [
    () => payload?.total_shipping_price_set,
    () => payload?.shipping_price_set,
    () => payload?.total_shipping_price,
    () => payload?.shipping_price,
  ]);

  const tax = firstMoney(payload, [
    () => payload?.current_total_tax_set,
    () => payload?.total_tax_set,
    () => payload?.current_total_tax,
    () => payload?.total_tax,
  ]);

  const total = firstMoney(payload, [
    () => payload?.current_total_price_set,
    () => payload?.total_price_set,
    () => payload?.current_total_price,
    () => payload?.total_price,
  ]);

  const currency = clean(total.currency || subtotal.currency || shipping.currency || tax.currency || payload?.currency || payload?.currencyCode);

  const lines = [
    subtotal.amount ? `Subtotal: ${formatMoneyValue(subtotal.amount, subtotal.currency || currency)}` : "",
    shipping.amount ? `Shipping: ${formatMoneyValue(shipping.amount, shipping.currency || currency)}` : "",
    tax.amount ? `Tax: ${formatMoneyValue(tax.amount, tax.currency || currency)}` : "",
    total.amount ? `Total: ${formatMoneyValue(total.amount, total.currency || currency)}` : "",
    currency ? `Currency: ${currency}` : "",
  ].filter(Boolean);

  return lines.length ? `Order totals:
${lines.join("\n")}` : "";
}

function appendSystemNote(currentNote, nextNote) {
  const current = clean(currentNote);
  const next = clean(nextNote);

  if (!current) return next || null;
  if (!next) return current;

  return `${current}\n\n${next}`;
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

function makePairsFromLocalizationExtensions(nodes) {
  return (nodes || []).flatMap((node) => {
    const key = clean(node?.key);
    const title = clean(node?.title);
    const countryCode = clean(node?.countryCode);
    const value = clean(node?.value);

    // IMPORTANT:
    // Do not use `purpose` as a lookup key here.
    // Shopify localized fiscal fields often share a generic purpose like TAX,
    // and matching PEC against TAX would incorrectly return the first fiscal value
    // (usually the codice fiscale) as the PEC.
    return [
      { key, value },
      { key: title, value },
      { key: countryCode && key ? `${countryCode}.${key}` : key, value },
    ].filter((pair) => clean(pair.key));
  });
}

function getPairValue(pairs, acceptedKeys) {
  const normalizedAcceptedKeys = acceptedKeys.map(normalizeKey).filter(Boolean);

  for (const pair of pairs || []) {
    const normalizedPairKey = normalizeKey(pair?.key);
    const value = clean(pair?.value);

    if (!normalizedPairKey || !value) continue;

    // Strict matching only. The previous bidirectional includes check allowed
    // generic keys such as TAX to match TAX_EMAIL_IT and polluted PEC with CF.
    if (normalizedAcceptedKeys.includes(normalizedPairKey)) {
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
  taxExemptApplied,
  administrativeNotes,
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
      taxExemptApplied: optionalBoolean(taxExemptApplied),
      status: "order_created",
      errorMessage: administrativeNotes || null,
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
        localizationExtensions(first: 20) {
          nodes {
            countryCode
            key
            purpose
            title
            value
          }
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
        lineItems(first: 100) {
          nodes {
            title
            sku
            quantity
            variantTitle
            taxable
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountedTotalSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            taxLines {
              title
              rate
              ratePercentage
              priceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
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
  const localizationPairs = makePairsFromLocalizationExtensions(order.localizationExtensions?.nodes || []);
  const customerMetafieldPairs = makePairsFromMetafields(customer.metafields?.nodes || []);
  const orderAttributePairs = (order.customAttributes || []).map((item) => ({
    key: clean(item?.key),
    value: clean(item?.value),
  }));

  // Priority: native Shopify localized checkout fields first, then custom attributes, then customer metafields.
  const allPairs = [...localizationPairs, ...orderAttributePairs, ...customerMetafieldPairs];

  const fiscalCode = getPairValue(allPairs, [
    "TAX_CREDENTIAL_IT",
    "IT.TAX_CREDENTIAL_IT",
    "tax credential",
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
    "TAX_EMAIL_IT",
    "IT.TAX_EMAIL_IT",
    "tax email",
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

  console.log("[orders/create] Native localized fiscal enrichment", {
    orderGid,
    localizationExtensions: (order.localizationExtensions?.nodes || []).map((field) => ({
      countryCode: field?.countryCode,
      key: field?.key,
      purpose: field?.purpose,
      title: field?.title,
      value: field?.value ? "[present]" : "",
    })),
    fiscalCodeFound: Boolean(fiscalCode),
    pecFound: Boolean(pec),
    sdiFound: Boolean(sdi),
  });

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
    billingAddressNote: formatBillingAddress(billingAddress),
    billingAddress,
    shippingAddress,
    orderItemsNote: formatOrderItems(order.lineItems?.nodes || []),
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



function toCustomerGid(customerId) {
  const raw = clean(customerId);
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

function normalizeVatForCompany(value) {
  return clean(value).toUpperCase().replace(/[\s.\-_/]/g, "");
}

function buildCompanyAddress(address = {}, fallback = {}) {
  const source = address && Object.keys(address).length ? address : fallback || {};
  const countryCode = clean(source.countryCodeV2 || source.country_code || source.countryCode);
  const zoneCode = clean(source.provinceCode || source.province_code || source.zoneCode);

  const result = {
    firstName: clean(source.firstName || source.first_name),
    lastName: clean(source.lastName || source.last_name),
    address1: clean(source.address1),
    address2: clean(source.address2),
    city: clean(source.city),
    zip: clean(source.zip),
    countryCode,
    zoneCode,
    phone: clean(source.phone),
  };

  return Object.fromEntries(Object.entries(result).filter(([, value]) => Boolean(value)));
}

async function updateCustomerIdentity(admin, customerId, firstName, lastName) {
  const customerGid = toCustomerGid(customerId);
  if (!customerGid || (!clean(firstName) && !clean(lastName))) return;

  const mutation = `#graphql
    mutation UpdateInvoiceCustomerIdentity($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id firstName lastName }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      input: {
        id: customerGid,
        ...(clean(firstName) ? { firstName: clean(firstName) } : {}),
        ...(clean(lastName) ? { lastName: clean(lastName) } : {}),
      },
    },
  });

  const data = await response.json();
  const errors = data?.data?.customerUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" | "));
}

async function findCompanyForInvoice(admin, customerGid, companyName, vatNumber) {
  if (customerGid) {
    const response = await admin.graphql(`#graphql
      query InvoiceCustomerCompanies($id: ID!) {
        customer(id: $id) {
          companyContactProfiles {
            company {
              id
              name
              externalId
              locations(first: 10) {
                nodes { id name }
              }
            }
          }
        }
      }
    `, { variables: { id: customerGid } });

    const data = await response.json();
    if (data?.errors?.length) throw new Error(data.errors.map((error) => error.message).join(" | "));

    const profiles = data?.data?.customer?.companyContactProfiles || [];
    const wantedName = clean(companyName).toLowerCase();
    const exact = profiles.find((profile) => clean(profile?.company?.name).toLowerCase() === wantedName);
    if (exact?.company?.id) return exact.company;
    if (profiles.length === 1 && profiles[0]?.company?.id) return profiles[0].company;
  }

  const vat = normalizeVatForCompany(vatNumber);
  if (vat) {
    const externalId = `invoice-${vat}`;
    const response = await admin.graphql(`#graphql
      query InvoiceCompanyByExternalId($query: String!) {
        companies(first: 10, query: $query) {
          nodes {
            id
            name
            externalId
            locations(first: 10) { nodes { id name } }
          }
        }
      }
    `, { variables: { query: `external_id:${externalId}` } });

    const data = await response.json();
    if (data?.errors?.length) throw new Error(data.errors.map((error) => error.message).join(" | "));
    const company = (data?.data?.companies?.nodes || []).find((item) => item?.externalId === externalId);
    if (company?.id) return company;
  }

  const wantedName = clean(companyName);
  if (wantedName) {
    const response = await admin.graphql(`#graphql
      query InvoiceCompanyByName($query: String!) {
        companies(first: 20, query: $query) {
          nodes {
            id
            name
            externalId
            locations(first: 10) { nodes { id name } }
          }
        }
      }
    `, { variables: { query: wantedName } });

    const data = await response.json();
    if (data?.errors?.length) throw new Error(data.errors.map((error) => error.message).join(" | "));
    const exact = (data?.data?.companies?.nodes || []).find(
      (item) => clean(item?.name).toLowerCase() === wantedName.toLowerCase(),
    );
    if (exact?.id) return exact;
  }

  return null;
}

async function createCompanyForInvoice(admin, {
  companyName,
  vatNumber,
  billingAddress,
  shippingAddress,
  reverseCharge,
}) {
  const vat = normalizeVatForCompany(vatNumber);
  const address = buildCompanyAddress(billingAddress, shippingAddress);
  const companyLocation = {
    name: clean(companyName),
    shippingAddress: address,
    billingSameAsShipping: true,
    ...(vat ? { taxRegistrationId: vat } : {}),
    ...(reverseCharge
      ? {
          taxExempt: true,
          taxExemptions: ["EU_REVERSE_CHARGE_EXEMPTION_RULE"],
        }
      : {}),
  };

  const mutation = `#graphql
    mutation CreateInvoiceCompany($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          name
          externalId
          locations(first: 10) { nodes { id name } }
        }
        userErrors { field message code }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      input: {
        company: {
          name: clean(companyName),
          ...(vat ? { externalId: `invoice-${vat}` } : {}),
        },
        companyLocation,
      },
    },
  });

  const data = await response.json();
  const errors = data?.data?.companyCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" | "));

  return data?.data?.companyCreate?.company || null;
}

async function assignCustomerToCompany(admin, companyId, customerGid) {
  if (!companyId || !customerGid) return;

  const mutation = `#graphql
    mutation AssignInvoiceCustomerToCompany($companyId: ID!, $customerId: ID!) {
      companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
        companyContact { id }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: { companyId, customerId: customerGid },
  });
  const data = await response.json();
  const errors = data?.data?.companyAssignCustomerAsContact?.userErrors || [];
  if (errors.length) {
    const message = errors.map((error) => error.message).join(" | ");
    if (!/already|contact/i.test(message)) throw new Error(message);
  }
}

async function setInvoiceCompanyMetafields(admin, ownerIds, fields) {
  const ids = (ownerIds || []).filter(Boolean);
  if (!ids.length) return;

  const metafields = ids.flatMap((ownerId) =>
    Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => ({
        ownerId,
        namespace: "custom",
        key,
        type: "single_line_text_field",
        value: String(value),
      })),
  );

  if (!metafields.length) return;

  const mutation = `#graphql
    mutation SetInvoiceCompanyFiscalMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, { variables: { metafields } });
  const data = await response.json();
  const errors = data?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" | "));
}

async function applyCompanyTaxSettings(admin, locationId, vatNumber, reverseCharge) {
  if (!locationId) return;

  const mutation = `#graphql
    mutation ApplyInvoiceCompanyTaxSettings(
      $companyLocationId: ID!,
      $taxRegistrationId: String,
      $taxExempt: Boolean,
      $exemptionsToAssign: [TaxExemption!]
    ) {
      companyLocationTaxSettingsUpdate(
        companyLocationId: $companyLocationId,
        taxRegistrationId: $taxRegistrationId,
        taxExempt: $taxExempt,
        exemptionsToAssign: $exemptionsToAssign
      ) {
        companyLocation { id }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      companyLocationId: locationId,
      taxRegistrationId: normalizeVatForCompany(vatNumber) || null,
      taxExempt: reverseCharge ? true : null,
      exemptionsToAssign: reverseCharge ? ["EU_REVERSE_CHARGE_EXEMPTION_RULE"] : [],
    },
  });

  const data = await response.json();
  const errors = data?.data?.companyLocationTaxSettingsUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" | "));
}

async function ensureInvoiceCompany(admin, {
  customerId,
  companyName,
  vatNumber,
  countryCode,
  pec,
  sdi,
  fiscalCode,
  reverseCharge,
  billingAddress,
  shippingAddress,
}) {
  const customerGid = toCustomerGid(customerId);
  if (!customerGid || !clean(companyName)) return null;

  let company = await findCompanyForInvoice(admin, customerGid, companyName, vatNumber);
  if (!company?.id) {
    company = await createCompanyForInvoice(admin, {
      companyName,
      vatNumber,
      billingAddress,
      shippingAddress,
      reverseCharge,
    });
  }
  if (!company?.id) throw new Error("Company creation returned no company ID");

  await assignCustomerToCompany(admin, company.id, customerGid);

  const locationId = company.locations?.nodes?.[0]?.id || "";
  if (locationId) {
    await applyCompanyTaxSettings(admin, locationId, vatNumber, reverseCharge);
  }

  await setInvoiceCompanyMetafields(admin, [company.id, locationId], {
    invoice_type: "company",
    company_name: companyName,
    vat_number: normalizeVatForCompany(vatNumber),
    invoice_country_code: clean(countryCode).toUpperCase(),
    pec: clean(pec).toLowerCase(),
    sdi: clean(sdi).toUpperCase(),
    fiscal_code: clean(fiscalCode).toUpperCase(),
    reverse_charge: String(Boolean(reverseCharge)),
  });

  console.log("[orders/create] Invoice company ensured", {
    customerGid,
    companyId: company.id,
    companyName: company.name,
    locationId,
    vatNumber: normalizeVatForCompany(vatNumber),
    reverseCharge: Boolean(reverseCharge),
  });

  return { companyId: company.id, locationId };
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
  const taxExemptApplied = getAttribute(payload, "tax_exempt_applied");
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
  const orderTotalsNote = formatOrderTotals(payload);
  const orderItemsNote = enrichedFiscalData?.orderItemsNote || formatPayloadOrderItems(payload);
  const fiscalDecisionNote = [
    "Invoice fiscal flags:",
    `Invoice type: ${invoiceType || "—"}`,
    `VIES checked: ${viesChecked || "—"}`,
    `VIES valid: ${viesValid || "—"}`,
    `Reverse charge: ${reverseCharge || "—"}`,
    `Tax exempt applied: ${taxExemptApplied || "—"}`,
    fiscalCode ? `Codice fiscale: ${fiscalCode}` : "Codice fiscale: —",
    pec ? `PEC: ${pec}` : "PEC: —",
    sdi ? `SDI: ${sdi}` : "SDI: —",
    vatNumber ? `VAT: ${vatNumber}` : "VAT: —",
  ].join("\n");

  const administrativeNotes = [
    fiscalDecisionNote,
    enrichedFiscalData?.billingAddressNote || "",
    orderTotalsNote,
    orderItemsNote,
  ].filter(Boolean).join("\n\n");

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
      taxExemptApplied,
      administrativeNotes,
    });

    invoiceSyncCount = syncResult?.count || 0;
  } catch (error) {
    return new Response(error?.message || "Invoice request DB sync failed", { status: 500 });
  }

  let customerCompanySyncNote = "";

  try {
    if (customerId) {
      await updateCustomerIdentity(admin, customerId, firstName, lastName);
    }

    if (invoiceType === "company" && customerId && companyName) {
      const companyResult = await ensureInvoiceCompany(admin, {
        customerId,
        companyName,
        vatNumber,
        countryCode: finalCountryCode,
        pec,
        sdi,
        fiscalCode,
        reverseCharge: reverseCharge === "true",
        billingAddress: enrichedFiscalData?.billingAddress || payload?.billing_address || payload?.billingAddress || {},
        shippingAddress: enrichedFiscalData?.shippingAddress || payload?.shipping_address || payload?.shippingAddress || {},
      });

      if (companyResult?.companyId) {
        customerCompanySyncNote = `Company sync: ${companyResult.companyId}${companyResult.locationId ? ` / ${companyResult.locationId}` : ""}`;
      }
    }
  } catch (error) {
    customerCompanySyncNote = `Company/customer sync failed: ${error?.message || "Unknown error"}`;
    console.error("[orders/create] Company/customer sync failed", {
      shop,
      orderGid,
      customerId,
      companyName,
      vatNumber,
      error: error?.message || String(error),
    });
  }

  if (customerCompanySyncNote) {
    const where = buildWhere({ shop, invoiceRequestId, cartToken });
    if (where) {
      await prisma.invoiceRequest.updateMany({
        where,
        data: {
          errorMessage: appendSystemNote(administrativeNotes, `System notes:\n${customerCompanySyncNote}`),
        },
      });
    }
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
      tax_exempt_applied: taxExemptApplied,
      invoice_request_id: invoiceRequestId,
    });

    await addOrderTags(admin, orderGid, [
      "invoice_requested",
      invoiceType === "private" ? "invoice_private" : "",
      invoiceType === "company" ? "invoice_company" : "",
      viesValid === "true" ? "vies_valid" : "",
      reverseCharge === "true" ? "reverse_charge" : "",
      taxExemptApplied === "true" ? "tax_exempt_applied" : "",
      viesChecked === "true" && viesValid !== "true" && reverseCharge === "true" ? "invoice_manual_review" : "",
    ]);

    return new Response(`OK - invoice synced (${invoiceSyncCount})`, { status: 200 });
  } catch (error) {
    const where = buildWhere({ shop, invoiceRequestId, cartToken });

    if (where) {
      await prisma.invoiceRequest.updateMany({
        where,
        data: {
          errorMessage: appendSystemNote(
            administrativeNotes,
            `System notes:\nOrder linked, but order metafields/tags failed: ${error?.message || "Unknown error"}`
          ),
        },
      });
    }

    return new Response(`OK - invoice synced (${invoiceSyncCount}), order decoration failed`, {
      status: 200,
    });
  }
}

import { data as json, useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_OPTIONS = [
  { value: "orders", label: "Solo ordini" },
  { value: "missing", label: "Ordini con dati mancanti" },
  { value: "cart", label: "Carrello / abbandonate" },
  { value: "all", label: "Tutte" },
  { value: "draft", label: "Draft" },
  { value: "validated", label: "Validated" },
  { value: "order_created", label: "Order created" },
  { value: "processed", label: "Processed" },
  { value: "rejected", label: "Rejected" },
  { value: "failed", label: "Failed" },
];

function clean(value) {
  return String(value || "").trim();
}

function cleanNullable(value) {
  const cleaned = clean(value);
  return cleaned || null;
}

function upperNullable(value) {
  const cleaned = clean(value).toUpperCase();
  return cleaned || null;
}

function optionalBooleanFromForm(value) {
  const cleaned = clean(value);
  if (cleaned === "") return null;
  return formBoolean(cleaned);
}

function formBoolean(value) {
  const cleaned = clean(value).toLowerCase();
  return cleaned === "true" || cleaned === "yes" || cleaned === "1" || cleaned === "on";
}

function formatDate(value) {
  if (!value) return "—";

  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch (_error) {
    return "—";
  }
}

function normalizeRequest(item) {
  return {
    ...item,
    createdAt: item.createdAt?.toISOString?.() || item.createdAt,
    updatedAt: item.updatedAt?.toISOString?.() || item.updatedAt,
  };
}

function getShopHandle(shop) {
  return String(shop || "").replace(".myshopify.com", "");
}

function getOrderUrl(shop, orderId) {
  if (!shop || !orderId) return "";

  return `https://admin.shopify.com/store/${getShopHandle(shop)}/orders/${orderId}`;
}

function buildInvoiceRequestWhere({ shop, status = "orders", search = "" }) {
  const and = [{ shop }];

  if (status === "orders") {
    and.push({
      OR: [
        { orderId: { not: null } },
        { orderName: { not: null } },
      ],
    });
  } else if (status === "missing") {
    and.push(buildOrderOnlyWhere(shop));
    and.push(buildMissingWhere());
  } else if (status === "cart") {
    and.push({
      AND: [
        { orderId: null },
        { orderName: null },
      ],
    });
  } else if (status !== "all") {
    and.push({ status });
  }

  if (search) {
    and.push({
      OR: [
        { companyName: { contains: search } },
        { vatNumber: { contains: search } },
        { pec: { contains: search } },
        { sdi: { contains: search } },
        { orderName: { contains: search } },
        { customerEmail: { contains: search } },
        { fiscalCode: { contains: search } },
        { firstName: { contains: search } },
        { lastName: { contains: search } },
      ],
    });
  }

  return and.length === 1 ? and[0] : { AND: and };
}

function buildOrderOnlyWhere(shop) {
  return {
    shop,
    OR: [
      { orderId: { not: null } },
      { orderName: { not: null } },
    ],
  };
}

function buildCartOnlyWhere(shop) {
  return {
    shop,
    AND: [
      { orderId: null },
      { orderName: null },
    ],
  };
}

function buildMissingWhere() {
  return {
    OR: [
      { errorMessage: null },
      { NOT: { errorMessage: { contains: "Order totals:" } } },
      { NOT: { errorMessage: { contains: "Order items:" } } },
      { invoiceType: "company", OR: [{ vatNumber: null }, { vatNumber: "" }] },
      { invoiceType: "company", OR: [{ countryCode: null }, { countryCode: "" }] },
      {
        AND: [
          { invoiceType: "company" },
          { countryCode: "IT" },
          { OR: [{ pec: null }, { pec: "" }] },
          { OR: [{ sdi: null }, { sdi: "" }] },
        ],
      },
      {
        AND: [
          { invoiceType: "private" },
          { countryCode: "IT" },
          { OR: [{ fiscalCode: null }, { fiscalCode: "" }] },
        ],
      },
    ],
  };
}

function hasNoteSection(note, sectionTitle) {
  return String(note || "").includes(sectionTitle);
}

function getMissingFlags(item) {
  const flags = [];
  const hasOrder = Boolean(item?.orderId || item?.orderName);
  const invoiceType = clean(item?.invoiceType);
  const countryCode = clean(item?.countryCode).toUpperCase();
  const notes = item?.errorMessage || "";

  if (!hasOrder) flags.push("ordine non collegato");
  if (hasOrder && !hasNoteSection(notes, "Order totals:")) flags.push("totali mancanti");
  if (hasOrder && !hasNoteSection(notes, "Order items:")) flags.push("prodotti mancanti");

  if (invoiceType === "company") {
    if (!clean(item?.companyName)) flags.push("azienda mancante");
    if (!countryCode) flags.push("paese mancante");
    if (!clean(item?.vatNumber)) flags.push("VAT mancante");
    if (countryCode === "IT") {
      if (!clean(item?.pec)) flags.push("PEC mancante");
      if (!clean(item?.sdi)) flags.push("SDI mancante");
    }
    if (countryCode && countryCode !== "IT" && item?.viesChecked && item?.viesValid !== true) {
      flags.push("VIES non valido");
    }
  }

  if (invoiceType === "private" && countryCode === "IT" && !clean(item?.fiscalCode)) {
    flags.push("CF mancante");
  }

  if (item?.status === "failed") flags.push("failed");

  return flags;
}

function missingTone(flags) {
  if (!flags?.length) return "success";
  if (flags.some((flag) => ["VAT mancante", "paese mancante", "totali mancanti", "prodotti mancanti", "failed"].includes(flag))) {
    return "error";
  }
  return "info";
}

function extractVatCandidate(...values) {
  const combined = values.map(clean).filter(Boolean).join(" ").toUpperCase();
  const match = combined.match(/\b(?:IT|AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)[A-Z0-9]{8,13}\b/);
  return match ? match[0] : "";
}

function moneyLine(label, money) {
  const amount = clean(money?.amount);
  const currency = clean(money?.currencyCode);
  if (!amount) return "";
  return `${label}: ${amount}${currency ? ` ${currency}` : ""}`;
}

function formatBackfillBillingAddress(address = {}) {
  const lines = [
    clean(address.company),
    [clean(address.firstName), clean(address.lastName)].filter(Boolean).join(" "),
    clean(address.address1),
    clean(address.address2),
    [clean(address.zip), clean(address.city), clean(address.provinceCode)].filter(Boolean).join(" "),
    clean(address.country || address.countryCodeV2),
    address.phone ? `Phone: ${clean(address.phone)}` : "",
  ].filter(Boolean);

  return lines.length ? `Billing address:\n${lines.join("\n")}` : "";
}

function formatBackfillOrderItems(items = []) {
  const lines = items.map((item) => {
    const sku = clean(item?.sku) || "NO-SKU";
    const title = [clean(item?.title), clean(item?.variantTitle)].filter(Boolean).join(" / ");
    const qty = item?.quantity || 0;
    const unit = item?.originalUnitPriceSet?.shopMoney;
    const total = item?.discountedTotalSet?.shopMoney;
    const taxes = (item?.taxLines || [])
      .map((tax) => {
        const title = clean(tax?.title) || "Tax";
        const rate = tax?.ratePercentage !== undefined && tax?.ratePercentage !== null ? `${tax.ratePercentage}%` : "";
        const amount = tax?.priceSet?.shopMoney?.amount ? `${tax.priceSet.shopMoney.amount} ${tax.priceSet.shopMoney.currencyCode || ""}`.trim() : "";
        return [title, rate, amount].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("; ");

    return `- ${sku} | ${title || "Item"} | Qty: ${qty} | Unit: ${unit?.amount || ""} ${unit?.currencyCode || ""} | Total: ${total?.amount || ""} ${total?.currencyCode || ""}${taxes ? ` | Tax: ${taxes}` : ""}`.trim();
  }).filter(Boolean);

  return lines.length ? `Order items:\n${lines.join("\n")}` : "";
}

function formatBackfillOrderTotals(order = {}) {
  const lines = [
    moneyLine("Subtotal", order.subtotalPriceSet?.shopMoney),
    moneyLine("Shipping", order.totalShippingPriceSet?.shopMoney),
    moneyLine("Tax", order.totalTaxSet?.shopMoney),
    moneyLine("Total", order.totalPriceSet?.shopMoney),
    order.currencyCode ? `Currency: ${order.currencyCode}` : "",
  ].filter(Boolean);

  return lines.length ? `Order totals:\n${lines.join("\n")}` : "";
}

function pairValue(pairs, keys) {
  const wanted = keys.map((key) => clean(key).toLowerCase());

  for (const pair of pairs || []) {
    const key = clean(pair?.key || pair?.name).toLowerCase();
    const value = clean(pair?.value);
    if (!key || !value) continue;
    if (wanted.some((item) => key === item || key.includes(item))) return value;
  }

  return "";
}

function getOrderGid(value) {
  const raw = clean(value);
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/Order/${raw}`;
}

async function fetchOrderForBackfill(admin, { orderId, orderName }) {
  const orderFields = `
    id
    legacyResourceId
    name
    email
    note
    currencyCode
    customAttributes { key value }
    subtotalPriceSet { shopMoney { amount currencyCode } }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    totalTaxSet { shopMoney { amount currencyCode } }
    totalPriceSet { shopMoney { amount currencyCode } }
    billingAddress {
      firstName lastName company address1 address2 city zip provinceCode country countryCodeV2 phone
    }
    shippingAddress {
      firstName lastName company address1 address2 city zip provinceCode country countryCodeV2 phone
    }
    lineItems(first: 100) {
      nodes {
        title sku quantity variantTitle taxable
        originalUnitPriceSet { shopMoney { amount currencyCode } }
        discountedTotalSet { shopMoney { amount currencyCode } }
        taxLines { title rate ratePercentage priceSet { shopMoney { amount currencyCode } } }
      }
    }
    customer {
      id legacyResourceId email firstName lastName
      metafields(first: 50) { nodes { namespace key value } }
    }
  `;

  if (orderId) {
    const response = await admin.graphql(`#graphql
      query BackfillOrderById($id: ID!) { order(id: $id) { ${orderFields} } }
    `, { variables: { id: getOrderGid(orderId) } });
    const payload = await response.json();
    if (payload?.errors?.length) throw new Error(payload.errors.map((error) => error.message).join(" | "));
    if (payload?.data?.order) return payload.data.order;
  }

  if (orderName) {
    const query = `name:${orderName.replace(/^#/, "\\#")}`;
    const response = await admin.graphql(`#graphql
      query BackfillOrderByName($query: String!) { orders(first: 1, query: $query) { nodes { ${orderFields} } } }
    `, { variables: { query } });
    const payload = await response.json();
    if (payload?.errors?.length) throw new Error(payload.errors.map((error) => error.message).join(" | "));
    if (payload?.data?.orders?.nodes?.[0]) return payload.data.orders.nodes[0];
  }

  throw new Error("Ordine Shopify non trovato per backfill.");
}

function buildBackfillDataFromOrder(order = {}, current = {}) {
  const billing = order.billingAddress || {};
  const shipping = order.shippingAddress || {};
  const customer = order.customer || {};
  const attributes = order.customAttributes || [];
  const metafields = (customer.metafields?.nodes || []).map((item) => ({
    key: `${item.namespace}.${item.key}`,
    value: item.value,
  }));
  const pairs = [...attributes, ...metafields];

  const fiscalCode = pairValue(pairs, ["fiscal_code", "codice_fiscale", "codice fiscale", "cf", "tax_code"]);
  const vatFromPairs = pairValue(pairs, ["vat_number", "partita_iva", "partita iva", "piva", "vat_id", "tax_id"]);
  const vatNumber = vatFromPairs || extractVatCandidate(billing.company, billing.firstName, billing.lastName, shipping.company);
  const pec = pairValue(pairs, ["pec", "certified_email", "posta certificata"]);
  const sdi = pairValue(pairs, ["sdi", "codice_sdi", "recipient_code", "codice_destinatario"]);
  const invoiceType = pairValue(pairs, ["invoice_type"]) || (vatNumber || billing.company ? "company" : "private");
  const countryCode = pairValue(pairs, ["invoice_country_code", "country_code"]) || billing.countryCodeV2 || shipping.countryCodeV2 || current.countryCode;

  const notes = [
    formatBackfillBillingAddress(billing),
    formatBackfillOrderTotals(order),
    formatBackfillOrderItems(order.lineItems?.nodes || []),
    order.note ? `Order note:\n${order.note}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    orderId: order.legacyResourceId ? String(order.legacyResourceId) : clean(current.orderId),
    orderName: clean(order.name || current.orderName),
    customerEmail: clean(order.email || customer.email || current.customerEmail).toLowerCase(),
    customerId: customer.legacyResourceId ? String(customer.legacyResourceId) : clean(customer.id || current.customerId),
    invoiceType,
    countryCode: clean(countryCode).toUpperCase(),
    firstName: clean(billing.firstName || shipping.firstName || customer.firstName || current.firstName),
    lastName: clean(billing.lastName || shipping.lastName || customer.lastName || current.lastName),
    fiscalCode,
    vatNumber,
    pec,
    sdi,
    companyName: clean(billing.company || shipping.company || current.companyName),
    status: "order_created",
    errorMessage: notes || current.errorMessage || null,
  };
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const status = clean(url.searchParams.get("status")) || "orders";
  const search = clean(url.searchParams.get("search"));
  const where = buildInvoiceRequestWhere({ shop: session.shop, status, search });

  const [requests, counts, orderCount, cartCount] = await Promise.all([
    prisma.invoiceRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.invoiceRequest.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: { status: true },
    }),
    prisma.invoiceRequest.count({ where: buildOrderOnlyWhere(session.shop) }),
    prisma.invoiceRequest.count({ where: buildCartOnlyWhere(session.shop) }),
  ]);

  return json({
    shop: session.shop,
    status,
    search,
    requests: requests.map(normalizeRequest),
    stats: { orderCount, cartCount },
    counts: {
      orders: orderCount,
      cart: cartCount,
      ...counts.reduce((acc, item) => {
        acc[item.status] = item._count.status;
        return acc;
      }, {}),
    },
  });
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = clean(formData.get("intent"));

  if (intent === "createManual") {
    const invoiceType = clean(formData.get("invoiceType")) || "private";
    const status = clean(formData.get("status")) || "order_created";
    const orderName = cleanNullable(formData.get("orderName"));
    const orderId = cleanNullable(formData.get("orderId"));

    const created = await prisma.invoiceRequest.create({
      data: {
        shop: session.shop,
        invoiceType,
        status,
        orderName,
        orderId,
        customerEmail: cleanNullable(formData.get("customerEmail")),
        firstName: cleanNullable(formData.get("firstName")),
        lastName: cleanNullable(formData.get("lastName")),
        fiscalCode: cleanNullable(formData.get("fiscalCode")),
        companyName: cleanNullable(formData.get("companyName")),
        countryCode: cleanNullable(formData.get("countryCode")),
        vatNumber: cleanNullable(formData.get("vatNumber")),
        pec: cleanNullable(formData.get("pec")),
        sdi: cleanNullable(formData.get("sdi")),
        viesChecked: formBoolean(formData.get("viesChecked")),
        viesValid: clean(formData.get("viesValid")) === "" ? null : formBoolean(formData.get("viesValid")),
        reverseCharge: formBoolean(formData.get("reverseCharge")),
        taxExemptApplied: formBoolean(formData.get("taxExemptApplied")),
        errorMessage: cleanNullable(formData.get("note")) || "Creata manualmente da Admin UI",
      },
    });

    return json({ ok: true, intent, id: created.id, status: created.status });
  }

  if (intent === "updateFiscal") {
    const id = clean(formData.get("id"));
    if (!id) return json({ ok: false, error: "Richiesta non valida." }, { status: 400 });

    const updated = await prisma.invoiceRequest.updateMany({
      where: { id, shop: session.shop },
      data: {
        invoiceType: clean(formData.get("invoiceType")) || undefined,
        status: clean(formData.get("status")) || undefined,
        orderName: cleanNullable(formData.get("orderName")),
        orderId: cleanNullable(formData.get("orderId")),
        customerEmail: cleanNullable(formData.get("customerEmail")),
        firstName: cleanNullable(formData.get("firstName")),
        lastName: cleanNullable(formData.get("lastName")),
        fiscalCode: upperNullable(formData.get("fiscalCode")),
        companyName: cleanNullable(formData.get("companyName")),
        countryCode: upperNullable(formData.get("countryCode")),
        vatNumber: upperNullable(formData.get("vatNumber")),
        pec: cleanNullable(formData.get("pec")),
        sdi: upperNullable(formData.get("sdi")),
        viesChecked: formBoolean(formData.get("viesChecked")),
        viesValid: optionalBooleanFromForm(formData.get("viesValid")),
        reverseCharge: formBoolean(formData.get("reverseCharge")),
        taxExemptApplied: formBoolean(formData.get("taxExemptApplied")),
        errorMessage: cleanNullable(formData.get("note")),
      },
    });

    if (!updated.count) return json({ ok: false, error: "Richiesta non trovata." }, { status: 404 });
    return json({ ok: true, intent, id, status: clean(formData.get("status")) || "updated" });
  }

  if (intent === "backfillOrder") {
    const id = clean(formData.get("id"));
    if (!id) return json({ ok: false, error: "Richiesta non valida." }, { status: 400 });

    const current = await prisma.invoiceRequest.findFirst({ where: { id, shop: session.shop } });
    if (!current) return json({ ok: false, error: "Richiesta non trovata." }, { status: 404 });

    const orderId = clean(formData.get("orderId") || current.orderId);
    const orderName = clean(formData.get("orderName") || current.orderName);
    const order = await fetchOrderForBackfill(admin, { orderId, orderName });
    const backfillData = buildBackfillDataFromOrder(order, current);

    const updated = await prisma.invoiceRequest.update({
      where: { id: current.id },
      data: backfillData,
    });

    return json({ ok: true, intent, id: updated.id, status: updated.status });
  }

  const id = clean(formData.get("id"));

  if (!id) {
    return json({ ok: false, error: "Richiesta non valida." }, { status: 400 });
  }

  const statusByIntent = {
    markProcessed: "processed",
    markRejected: "rejected",
    markValidated: "validated",
  };

  const nextStatus = statusByIntent[intent];

  if (!nextStatus) {
    return json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
  }

  const updated = await prisma.invoiceRequest.updateMany({
    where: {
      id,
      shop: session.shop,
    },
    data: {
      status: nextStatus,
    },
  });

  if (!updated.count) {
    return json({ ok: false, error: "Richiesta non trovata." }, { status: 404 });
  }

  return json({ ok: true, intent, id, status: nextStatus });
}

export default function InvoiceRequestsPage() {
  const { shop, status, search, requests, counts, stats } = useLoaderData();
  const fetcher = useFetcher();
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [selected, setSelected] = useState(null);
  const [showManualForm, setShowManualForm] = useState(false);

  function handleFiltersSubmit(event) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const params = new URLSearchParams(location.search);

    const nextSearch = clean(formData.get("search"));
    const nextStatus = clean(formData.get("status")) || "orders";

    if (nextSearch) {
      params.set("search", nextSearch);
    } else {
      params.delete("search");
    }

    params.set("status", nextStatus);

    const query = params.toString();
    navigate(query ? `/app/invoice-requests?${query}` : "/app/invoice-requests");
  }

  function handleResetFilters(event) {
    event.preventDefault();

    const params = new URLSearchParams(location.search);
    params.delete("search");
    params.delete("status");

    const query = params.toString();
    navigate(query ? `/app/invoice-requests?${query}` : "/app/invoice-requests");
  }

  useEffect(() => {
    if (!fetcher.data?.ok) return;

    if (["createManual", "updateFiscal", "backfillOrder"].includes(fetcher.data.intent)) {
      setShowManualForm(false);
      revalidator.revalidate();
      return;
    }

    if (selected?.id === fetcher.data.id) {
      setSelected((current) =>
        current ? { ...current, status: fetcher.data.status } : current
      );
    }
  }, [fetcher.data, selected?.id, revalidator]);

  const totalCount = Number(stats?.orderCount || 0);
  const cartCount = Number(stats?.cartCount || 0);

  const embeddedQueryParams = useMemo(() => {
    const params = new URLSearchParams(location.search);
    params.delete("search");
    params.delete("status");
    return Array.from(params.entries());
  }, [location.search]);

  const resetHref = useMemo(() => {
    const params = new URLSearchParams(location.search);
    params.delete("search");
    params.delete("status");
    const query = params.toString();
    return query ? `/app/invoice-requests?${query}` : "/app/invoice-requests";
  }, [location.search]);

  const exportHref = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const query = params.toString();
    return query ? `/app/invoice-requests/export?${query}` : "/app/invoice-requests/export";
  }, [location.search]);

  const printAllHref = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const query = params.toString();
    return query ? `/app/invoice-requests/print-all?${query}` : "/app/invoice-requests/print-all";
  }, [location.search]);

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <div>
          <h1 style={styles.title}>Invoice Requests</h1>
          <p style={styles.subtitle}>
            Di default vedi solo richieste collegate a ordini reali. Quelle da carrello/checkout abbandonato restano filtrabili ma non finiscono nel flusso amministrativo.
          </p>
        </div>
        <div style={styles.counterBox}>
          <strong>{totalCount}</strong>
          <span>ordini con richiesta</span>
          <small style={styles.counterSubtext}>{cartCount} carrello/abbandonate</small>
        </div>
      </div>

      <section style={styles.card}>
        <div style={styles.toolbar}>
          <form method="get" style={styles.filtersForm} onSubmit={handleFiltersSubmit}>
            {embeddedQueryParams.map(([key, value], index) => (
              <input key={`${key}-${index}`} type="hidden" name={key} value={value} />
            ))}
            <input
              type="search"
              name="search"
              defaultValue={search}
              placeholder="Cerca azienda, VAT, PEC, ordine..."
              style={styles.input}
            />
            <select name="status" defaultValue={status} style={styles.select}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                  {option.value !== "all" && counts?.[option.value]
                    ? ` (${counts[option.value]})`
                    : ""}
                </option>
              ))}
            </select>
            <button type="submit" style={styles.primaryButton}>Filtra</button>
            <a href={resetHref} style={styles.secondaryLink} onClick={handleResetFilters}>Reset</a>
            <a href={exportHref} style={styles.secondaryLink}>Esporta CSV</a>
            <a href={printAllHref} target="_blank" rel="noreferrer" style={styles.secondaryLink}>Stampa facsimili</a>
            <button
              type="button"
              style={styles.smallButton}
              onClick={() => setShowManualForm((value) => !value)}
            >
              {showManualForm ? "Chiudi inserimento" : "Crea manuale"}
            </button>
          </form>
        </div>

        {showManualForm && <ManualRequestForm fetcher={fetcher} />}

        {fetcher.data?.ok && fetcher.data.intent === "createManual" && (
          <div style={styles.success}>Richiesta manuale creata correttamente.</div>
        )}

        {fetcher.data?.error && (
          <div style={styles.error}>{fetcher.data.error}</div>
        )}

        {requests.length === 0 ? (
          <div style={styles.empty}>Nessuna richiesta trovata.</div>
        ) : (
          <div style={styles.tableWrapper}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Data</th>
                  <th style={styles.th}>Tipo</th>
                  <th style={styles.th}>Azienda / Cliente</th>
                  <th style={styles.th}>VAT</th>
                  <th style={styles.th}>VIES</th>
                  <th style={styles.th}>RC</th>
                  <th style={styles.th}>Ordine</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Check</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => {
                  const missingFlags = getMissingFlags(request);
                  return (
                  <tr key={request.id} style={styles.tr}>
                    <td style={styles.td}>{formatDate(request.createdAt)}</td>
                    <td style={styles.td}>{request.invoiceType || "—"}</td>
                    <td style={styles.td}>
                      <strong>{request.companyName || request.customerEmail || "—"}</strong>
                      {request.pec ? <span style={styles.mutedBlock}>{request.pec}</span> : null}
                    </td>
                    <td style={styles.td}>
                      {request.countryCode || "—"} {request.vatNumber || ""}
                    </td>
                    <td style={styles.td}>
                      <Badge tone={request.viesValid ? "success" : request.viesChecked ? "error" : "neutral"}>
                        {request.viesValid ? "Valid" : request.viesChecked ? "Invalid" : "—"}
                      </Badge>
                    </td>
                    <td style={styles.td}>
                      <Badge tone={request.reverseCharge ? "success" : "neutral"}>
                        {request.reverseCharge ? "Yes" : "No"}
                      </Badge>
                    </td>
                    <td style={styles.td}>
                      {request.orderId ? (
                        <a href={getOrderUrl(shop, request.orderId)} target="_blank" rel="noreferrer" style={styles.link}>
                          {request.orderName || `#${request.orderId}`}
                        </a>
                      ) : "—"}
                    </td>
                    <td style={styles.td}><StatusBadge status={request.status} /></td>
                    <td style={styles.td}>
                      <Badge tone={missingTone(missingFlags)}>
                        {missingFlags.length ? `${missingFlags.length} missing` : "OK"}
                      </Badge>
                    </td>
                    <td style={styles.tdRight}>
                      <button type="button" style={styles.smallButton} onClick={() => setSelected(request)}>
                        View
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <RequestDetail
          shop={shop}
          request={selected}
          fetcher={fetcher}
          embeddedSearch={location.search}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function ManualRequestForm({ fetcher }) {
  return (
    <div style={styles.manualBox}>
      <div style={styles.manualHeader}>
        <div>
          <h2 style={styles.manualTitle}>Crea richiesta manuale</h2>
          <p style={styles.subtitle}>
            Inserisci una richiesta già nota o recuperata da un ordine storico. Non modifica Shopify: salva solo nel database dell’app.
          </p>
        </div>
      </div>

      <fetcher.Form method="post" style={styles.manualForm}>
        <input type="hidden" name="intent" value="createManual" />

        <label style={styles.fieldLabel}>
          Tipo fattura
          <select name="invoiceType" defaultValue="private" style={styles.inputFull}>
            <option value="private">Privato</option>
            <option value="company">Azienda</option>
          </select>
        </label>

        <label style={styles.fieldLabel}>
          Status
          <select name="status" defaultValue="order_created" style={styles.inputFull}>
            <option value="draft">Draft</option>
            <option value="validated">Validated</option>
            <option value="order_created">Order created</option>
            <option value="processed">Processed</option>
            <option value="rejected">Rejected</option>
            <option value="failed">Failed</option>
          </select>
        </label>

        <label style={styles.fieldLabel}>
          Ordine Shopify
          <input name="orderName" placeholder="#24751" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          Order ID Shopify
          <input name="orderId" placeholder="gid o ID numerico, opzionale" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          Email cliente
          <input name="customerEmail" type="email" placeholder="cliente@example.com" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          Nome
          <input name="firstName" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          Cognome
          <input name="lastName" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          Codice fiscale
          <input name="fiscalCode" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          Azienda
          <input name="companyName" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          Paese
          <input name="countryCode" placeholder="IT" maxLength={2} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          Partita IVA / VAT
          <input name="vatNumber" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          PEC
          <input name="pec" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>
          SDI
          <input name="sdi" style={styles.inputFull} />
        </label>

        <label style={styles.checkboxLabel}>
          <input type="checkbox" name="viesChecked" value="true" />
          VIES checked
        </label>

        <label style={styles.checkboxLabel}>
          <input type="checkbox" name="viesValid" value="true" />
          VIES valid
        </label>

        <label style={styles.checkboxLabel}>
          <input type="checkbox" name="reverseCharge" value="true" />
          Reverse charge
        </label>

        <label style={styles.checkboxLabel}>
          <input type="checkbox" name="taxExemptApplied" value="true" />
          Tax exempt applied
        </label>

        <label style={{ ...styles.fieldLabel, gridColumn: "1 / -1" }}>
          Nota interna
          <textarea name="note" rows={3} style={styles.textarea} placeholder="Es. Richiesta inserita manualmente da ordine storico" />
        </label>

        <div style={styles.manualActions}>
          <button type="submit" style={styles.primaryButton}>
            Salva richiesta manuale
          </button>
        </div>
      </fetcher.Form>
    </div>
  );
}

function RequestDetail({ shop, request, fetcher, embeddedSearch = "", onClose }) {
  const orderUrl = getOrderUrl(shop, request.orderId);
  const printHref = (() => {
    const params = new URLSearchParams(embeddedSearch ? embeddedSearch.slice(1) : "");
    params.set("id", request.id);
    return `/app/invoice-requests/print?${params.toString()}`;
  })();
  const isPrivate = request.invoiceType === "private";
  const isCompany = request.invoiceType === "company";
  const missingFlags = getMissingFlags(request);

  return (
    <div style={styles.drawerBackdrop} onClick={onClose}>
      <aside style={styles.drawer} onClick={(event) => event.stopPropagation()}>
        <div style={styles.drawerHeader}>
          <div>
            <h2 style={styles.drawerTitle}>Invoice request</h2>
            <p style={styles.subtitle}>{request.id}</p>
          </div>
          <button type="button" style={styles.iconButton} onClick={onClose}>×</button>
        </div>

        <div style={styles.detailGrid}>
          <h3 style={styles.sectionTitle}>Richiesta</h3>
          <Detail label="Status" value={<StatusBadge status={request.status} />} />
          <Detail label="Missing flags" value={missingFlags.length ? missingFlags.join(" · ") : "OK"} />
          <Detail label="Created" value={formatDate(request.createdAt)} />
          <Detail label="Updated" value={formatDate(request.updatedAt)} />
          <Detail label="Invoice type" value={isPrivate ? "Privato" : isCompany ? "Azienda" : request.invoiceType || "—"} />

          <h3 style={styles.sectionTitle}>Ordine Shopify</h3>
          <Detail label="Order" value={orderUrl ? <a href={orderUrl} target="_blank" rel="noreferrer" style={styles.link}>{request.orderName || request.orderId}</a> : "—"} />
          <Detail label="Order ID" value={request.orderId || "—"} />
          <Detail label="Customer email" value={request.customerEmail || "—"} />
          <Detail label="Customer ID" value={request.customerId || "—"} />

          <h3 style={styles.sectionTitle}>Dati fiscali</h3>
          {isPrivate ? (
            <>
              <Detail label="Nome" value={[request.firstName, request.lastName].filter(Boolean).join(" ") || "—"} />
              <Detail label="Codice fiscale" value={request.fiscalCode || "—"} />
            </>
          ) : (
            <>
              <Detail label="Company" value={request.companyName || "—"} />
              <Detail label="Country" value={request.countryCode || "—"} />
              <Detail label="VAT" value={request.vatNumber || "—"} />
              <Detail label="PEC" value={request.pec || "—"} />
              <Detail label="SDI" value={request.sdi || "—"} />
              <Detail label="VIES checked" value={request.viesChecked ? "Yes" : "No"} />
              <Detail label="VIES valid" value={request.viesValid === null || request.viesValid === undefined ? "—" : request.viesValid ? "Yes" : "No"} />
              <Detail label="Reverse charge" value={request.reverseCharge ? "Yes" : "No"} />
              <Detail label="Tax exempt applied" value={request.taxExemptApplied ? "Yes" : "No"} />
            </>
          )}

          <h3 style={styles.sectionTitle}>Note, prodotti e debug</h3>
          <Detail label="Invoice request ID" value={request.id} />
          <Detail label="Cart token" value={request.cartToken || "—"} />
          <Detail label="Checkout token" value={request.checkoutToken || "—"} />
          <Detail label="Note amministrative / Prodotti" value={request.errorMessage || "—"} />
        </div>

        <UpdateFiscalForm request={request} fetcher={fetcher} />

        <div style={styles.actionsRow}>
          <BackfillForm request={request} fetcher={fetcher} />
          <a href={printHref} target="_blank" rel="noreferrer" style={{ ...styles.actionButton, ...styles.secondaryButton, textDecoration: "none" }}>
            Stampa facsimile
          </a>
          <StatusForm fetcher={fetcher} id={request.id} intent="markProcessed" label="Mark processed" />
          <StatusForm fetcher={fetcher} id={request.id} intent="markRejected" label="Reject" variant="danger" />
          <StatusForm fetcher={fetcher} id={request.id} intent="markValidated" label="Back to validated" variant="secondary" />
        </div>
      </aside>
    </div>
  );
}


function BackfillForm({ request, fetcher }) {
  return (
    <fetcher.Form method="post" style={{ display: "inline" }}>
      <input type="hidden" name="intent" value="backfillOrder" />
      <input type="hidden" name="id" value={request.id} />
      <input type="hidden" name="orderId" value={request.orderId || ""} />
      <input type="hidden" name="orderName" value={request.orderName || ""} />
      <button type="submit" style={{ ...styles.actionButton, ...styles.secondaryButton }}>
        Backfill da Shopify
      </button>
    </fetcher.Form>
  );
}

function UpdateFiscalForm({ request, fetcher }) {
  return (
    <div style={styles.editBox}>
      <h3 style={styles.sectionTitle}>Aggiungi / correggi dati mancanti</h3>
      <fetcher.Form method="post" style={styles.editForm}>
        <input type="hidden" name="intent" value="updateFiscal" />
        <input type="hidden" name="id" value={request.id} />

        <label style={styles.fieldLabel}>Tipo
          <select name="invoiceType" defaultValue={request.invoiceType || "private"} style={styles.inputFull}>
            <option value="private">Privato</option>
            <option value="company">Azienda</option>
          </select>
        </label>

        <label style={styles.fieldLabel}>Status
          <select name="status" defaultValue={request.status || "order_created"} style={styles.inputFull}>
            <option value="validated">Validated</option>
            <option value="order_created">Order created</option>
            <option value="processed">Processed</option>
            <option value="rejected">Rejected</option>
            <option value="failed">Failed</option>
          </select>
        </label>

        <label style={styles.fieldLabel}>Ordine
          <input name="orderName" defaultValue={request.orderName || ""} placeholder="#24767" style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>Order ID
          <input name="orderId" defaultValue={request.orderId || ""} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>Email
          <input name="customerEmail" defaultValue={request.customerEmail || ""} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>Nome
          <input name="firstName" defaultValue={request.firstName || ""} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>Cognome
          <input name="lastName" defaultValue={request.lastName || ""} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>Codice fiscale
          <input name="fiscalCode" defaultValue={request.fiscalCode || ""} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>Azienda
          <input name="companyName" defaultValue={request.companyName || ""} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>Paese
          <input name="countryCode" defaultValue={request.countryCode || ""} maxLength={2} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>VAT
          <input name="vatNumber" defaultValue={request.vatNumber || ""} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>PEC
          <input name="pec" defaultValue={request.pec || ""} style={styles.inputFull} />
        </label>

        <label style={styles.fieldLabel}>SDI
          <input name="sdi" defaultValue={request.sdi || ""} style={styles.inputFull} />
        </label>

        <label style={styles.checkboxLabel}><input type="checkbox" name="viesChecked" value="true" defaultChecked={Boolean(request.viesChecked)} /> VIES checked</label>
        <label style={styles.checkboxLabel}><input type="checkbox" name="viesValid" value="true" defaultChecked={Boolean(request.viesValid)} /> VIES valid</label>
        <label style={styles.checkboxLabel}><input type="checkbox" name="reverseCharge" value="true" defaultChecked={Boolean(request.reverseCharge)} /> Reverse charge</label>
        <label style={styles.checkboxLabel}><input type="checkbox" name="taxExemptApplied" value="true" defaultChecked={Boolean(request.taxExemptApplied)} /> Tax exempt applied</label>

        <label style={{ ...styles.fieldLabel, gridColumn: "1 / -1" }}>Note amministrative / snapshot
          <textarea name="note" defaultValue={request.errorMessage || ""} rows={8} style={styles.textarea} />
        </label>

        <div style={styles.manualActions}>
          <button type="submit" style={styles.primaryButton}>Salva correzioni</button>
        </div>
      </fetcher.Form>
    </div>
  );
}

function StatusForm({ fetcher, id, intent, label, variant = "primary" }) {
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        style={{
          ...styles.actionButton,
          ...(variant === "danger" ? styles.dangerButton : {}),
          ...(variant === "secondary" ? styles.secondaryButton : {}),
        }}
      >
        {label}
      </button>
    </fetcher.Form>
  );
}

function Detail({ label, value }) {
  return (
    <div style={styles.detailItem}>
      <span style={styles.detailLabel}>{label}</span>
      <span style={styles.detailValue}>{value}</span>
    </div>
  );
}

function StatusBadge({ status }) {
  const tone =
    status === "processed" ? "success" :
    status === "rejected" || status === "failed" ? "error" :
    status === "order_created" ? "info" :
    "neutral";

  return <Badge tone={tone}>{status || "—"}</Badge>;
}

function Badge({ tone = "neutral", children }) {
  return <span style={{ ...styles.badge, ...styles[`badge_${tone}`] }}>{children}</span>;
}

const styles = {
  page: {
    padding: 24,
    maxWidth: 1240,
    margin: "0 auto",
    color: "#202223",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    alignItems: "flex-start",
    marginBottom: 20,
  },
  title: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.2,
  },
  subtitle: {
    margin: "6px 0 0",
    color: "#6d7175",
    fontSize: 14,
  },
  counterBox: {
    minWidth: 120,
    padding: 14,
    border: "1px solid #dfe3e8",
    borderRadius: 12,
    background: "#fff",
    display: "grid",
    gap: 4,
    textAlign: "right",
    fontSize: 13,
    color: "#6d7175",
  },
  counterSubtext: {
    fontSize: 11,
    color: "#8c9196",
  },
  editBox: {
    marginTop: 18,
    padding: 14,
    border: "1px solid #dfe3e8",
    borderRadius: 12,
    background: "#fafbfb",
  },
  editForm: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 12,
  },
  card: {
    background: "#fff",
    border: "1px solid #dfe3e8",
    borderRadius: 12,
    overflow: "hidden",
  },
  toolbar: {
    padding: 16,
    borderBottom: "1px solid #dfe3e8",
  },
  filtersForm: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
  },
  input: {
    minWidth: 260,
    flex: "1 1 280px",
    padding: "10px 12px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    fontSize: 14,
  },
  select: {
    minWidth: 180,
    padding: "10px 12px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    fontSize: 14,
  },
  primaryButton: {
    padding: "10px 14px",
    border: "1px solid #202223",
    borderRadius: 8,
    background: "#202223",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  },
  secondaryLink: {
    color: "#2c6ecb",
    textDecoration: "none",
    fontSize: 14,
  },
  error: {
    margin: 16,
    padding: 12,
    borderRadius: 8,
    background: "#fff4f4",
    color: "#d72c0d",
  },
  success: {
    margin: 16,
    padding: 12,
    borderRadius: 8,
    background: "#e3f1df",
    color: "#108043",
  },
  manualBox: {
    margin: 16,
    padding: 16,
    border: "1px solid #dfe3e8",
    borderRadius: 12,
    background: "#fafbfb",
  },
  manualHeader: {
    marginBottom: 14,
  },
  manualTitle: {
    margin: 0,
    fontSize: 18,
  },
  manualForm: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 12,
  },
  fieldLabel: {
    display: "grid",
    gap: 6,
    color: "#6d7175",
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  inputFull: {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    color: "#202223",
    fontSize: 14,
    textTransform: "none",
    letterSpacing: 0,
    fontWeight: 400,
  },
  textarea: {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    color: "#202223",
    fontSize: 14,
    resize: "vertical",
    textTransform: "none",
    letterSpacing: 0,
    fontWeight: 400,
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "#202223",
    fontSize: 14,
  },
  manualActions: {
    gridColumn: "1 / -1",
    display: "flex",
    justifyContent: "flex-end",
  },
  empty: {
    padding: 28,
    color: "#6d7175",
  },
  tableWrapper: {
    overflowX: "auto",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  th: {
    textAlign: "left",
    padding: "12px 14px",
    color: "#6d7175",
    background: "#f6f6f7",
    borderBottom: "1px solid #dfe3e8",
    whiteSpace: "nowrap",
  },
  tr: {
    borderBottom: "1px solid #f1f2f3",
  },
  td: {
    padding: "12px 14px",
    verticalAlign: "top",
    whiteSpace: "nowrap",
  },
  tdRight: {
    padding: "12px 14px",
    textAlign: "right",
  },
  mutedBlock: {
    display: "block",
    color: "#6d7175",
    marginTop: 4,
    fontSize: 12,
  },
  link: {
    color: "#2c6ecb",
    textDecoration: "none",
  },
  smallButton: {
    padding: "7px 10px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    cursor: "pointer",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 22,
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    background: "#f1f2f3",
    color: "#202223",
  },
  badge_success: { background: "#e3f1df", color: "#108043" },
  badge_error: { background: "#fed3d1", color: "#d72c0d" },
  badge_info: { background: "#e0f0ff", color: "#2c6ecb" },
  badge_neutral: { background: "#f1f2f3", color: "#6d7175" },
  drawerBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.32)",
    zIndex: 9999,
    display: "flex",
    justifyContent: "flex-end",
  },
  drawer: {
    width: "min(560px, 100vw)",
    height: "100vh",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "#fff",
    boxShadow: "-16px 0 32px rgba(0,0,0,0.18)",
  },
  drawerHeader: {
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    padding: 24,
    borderBottom: "1px solid #dfe3e8",
  },
  drawerTitle: {
    margin: 0,
    fontSize: 22,
  },
  iconButton: {
    width: 36,
    height: 36,
    border: "1px solid #dfe3e8",
    borderRadius: 8,
    background: "#fff",
    cursor: "pointer",
    fontSize: 22,
    lineHeight: 1,
  },
  detailGrid: {
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    display: "grid",
    gap: 10,
    padding: 24,
  },
  sectionTitle: {
    margin: "18px 0 2px",
    paddingTop: 14,
    borderTop: "1px solid #f1f2f3",
    color: "#202223",
    fontSize: 13,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  detailItem: {
    display: "grid",
    gap: 4,
    padding: "10px 0",
    borderBottom: "1px solid #f1f2f3",
  },
  detailLabel: {
    color: "#6d7175",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  detailValue: {
    fontSize: 14,
    wordBreak: "break-word",
  },
  actionsRow: {
    flex: "0 0 auto",
    position: "sticky",
    bottom: 0,
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    padding: 16,
    borderTop: "1px solid #dfe3e8",
    background: "#fff",
    zIndex: 2,
  },
  actionButton: {
    padding: "10px 14px",
    border: "1px solid #202223",
    borderRadius: 8,
    background: "#202223",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  },
  dangerButton: {
    borderColor: "#d72c0d",
    background: "#d72c0d",
  },
  secondaryButton: {
    borderColor: "#c9cccf",
    background: "#fff",
    color: "#202223",
  },
};

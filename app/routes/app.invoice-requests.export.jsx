import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function clean(value) {
  return String(value || "").trim();
}

function csvCell(value) {
  if (value === null || value === undefined) return "";

  const text = String(value)
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.includes(";") || text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function formatDate(value) {
  if (!value) return "";

  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch (_error) {
    return "";
  }
}

function yesNo(value) {
  if (value === null || value === undefined) return "";
  return value ? "Sì" : "No";
}

function cleanFlag(value) {
  return String(value || "").trim();
}

function hasNoteSection(note, sectionTitle) {
  return String(note || "").includes(sectionTitle);
}

function getMissingFlags(item) {
  const flags = [];
  const hasOrder = Boolean(item?.orderId || item?.orderName);
  const invoiceType = cleanFlag(item?.invoiceType);
  const countryCode = cleanFlag(item?.countryCode).toUpperCase();
  const notes = item?.errorMessage || "";

  if (!hasOrder) flags.push("ordine non collegato");
  if (hasOrder && !hasNoteSection(notes, "Order totals:")) flags.push("totali mancanti");
  if (hasOrder && !hasNoteSection(notes, "Order items:")) flags.push("prodotti mancanti");

  if (invoiceType === "company") {
    if (!cleanFlag(item?.companyName)) flags.push("azienda mancante");
    if (!countryCode) flags.push("paese mancante");
    if (!cleanFlag(item?.vatNumber)) flags.push("VAT mancante");
    if (countryCode === "IT") {
      if (!cleanFlag(item?.pec)) flags.push("PEC mancante");
      if (!cleanFlag(item?.sdi)) flags.push("SDI mancante");
    }
    if (countryCode && countryCode !== "IT" && item?.viesChecked && item?.viesValid !== true) {
      flags.push("VIES non valido");
    }
  }

  if (invoiceType === "private" && countryCode === "IT" && !cleanFlag(item?.fiscalCode)) {
    flags.push("CF mancante");
  }

  if (item?.status === "failed") flags.push("failed");

  return flags;
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

function extractNoteLineValue(note, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\n)${escapedLabel}:\\s*([^\\n]+)`, "i");
  const match = String(note || "").match(regex);
  return match ? clean(match[1]) : "";
}

function extractMoneyParts(value) {
  const text = clean(value);
  if (!text) return { amount: "", currency: "" };

  const match = text.match(/^(-?\d+(?:[.,]\d+)?)\s*([A-Z]{3})?$/i);
  if (!match) return { amount: text, currency: "" };

  return {
    amount: match[1].replace(",", "."),
    currency: clean(match[2]).toUpperCase(),
  };
}

function extractProductsSummary(note) {
  const text = String(note || "");
  const match = text.match(/Order items:\n([\s\S]*?)(?:\n\n[A-Za-z ].*?:|$)/);

  if (!match) return "";

  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean)
    .join(" | ");
}

function makeDerivedExportValues(item) {
  const notes = item?.errorMessage || "";
  const subtotal = extractMoneyParts(extractNoteLineValue(notes, "Subtotal"));
  const shipping = extractMoneyParts(extractNoteLineValue(notes, "Shipping"));
  const tax = extractMoneyParts(extractNoteLineValue(notes, "Tax"));
  const total = extractMoneyParts(extractNoteLineValue(notes, "Total"));
  const currency = clean(
    extractNoteLineValue(notes, "Currency") ||
      total.currency ||
      subtotal.currency ||
      shipping.currency ||
      tax.currency
  );

  return {
    orderSubtotal: subtotal.amount,
    orderShipping: shipping.amount,
    orderTax: tax.amount,
    orderTotal: total.amount,
    orderCurrency: currency,
    productsSummary: extractProductsSummary(notes),
  };
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
    and.push({ OR: [{ orderId: { not: null } }, { orderName: { not: null } }] });
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

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const status = clean(url.searchParams.get("status")) || "orders";
  const search = clean(url.searchParams.get("search"));
  const where = buildInvoiceRequestWhere({ shop: session.shop, status, search });

  const requests = await prisma.invoiceRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const columns = [
    ["createdAt", "Data richiesta"],
    ["updatedAt", "Ultimo aggiornamento"],
    ["status", "Status"],
    ["missingFlags", "Dati mancanti"],
    ["invoiceType", "Tipo fattura"],
    ["orderName", "Ordine Shopify"],
    ["orderId", "Order ID"],
    ["customerEmail", "Email cliente"],
    ["firstName", "Nome"],
    ["lastName", "Cognome"],
    ["fiscalCode", "Codice fiscale"],
    ["companyName", "Azienda"],
    ["countryCode", "Paese"],
    ["vatNumber", "Partita IVA / VAT"],
    ["pec", "PEC"],
    ["sdi", "SDI"],
    ["viesChecked", "VIES controllato"],
    ["viesValid", "VIES valido"],
    ["reverseCharge", "Reverse charge"],
    ["taxExemptApplied", "Tax exempt applicato"],
    ["orderSubtotal", "Subtotale ordine"],
    ["orderShipping", "Spedizione"],
    ["orderTax", "Tasse"],
    ["orderTotal", "Totale ordine"],
    ["orderCurrency", "Valuta"],
    ["productsSummary", "Prodotti"],
    ["errorMessage", "Note / Billing address / Products"],
    ["id", "Invoice request ID"],
    ["cartToken", "Cart token"],
    ["checkoutToken", "Checkout token"],
  ];

  const rows = [
    columns.map(([, label]) => csvCell(label)).join(";"),
    ...requests.map((item) => {
      const derived = makeDerivedExportValues(item);

      return columns
        .map(([key]) => {
          if (key === "createdAt" || key === "updatedAt") return csvCell(formatDate(item[key]));
          if (key === "missingFlags") return csvCell(getMissingFlags(item).join(" | ") || "OK");
          if (["viesChecked", "viesValid", "reverseCharge", "taxExemptApplied"].includes(key)) {
            return csvCell(yesNo(item[key]));
          }
          if (Object.prototype.hasOwnProperty.call(derived, key)) {
            return csvCell(derived[key]);
          }
          return csvCell(item[key]);
        })
        .join(";");
    }),
  ];

  const today = new Date().toISOString().slice(0, 10);
  const csv = `\uFEFF${rows.join("\r\n")}`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoice-requests-${status}-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

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

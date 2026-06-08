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

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const status = clean(url.searchParams.get("status")) || "all";
  const search = clean(url.searchParams.get("search"));

  const where = {
    shop: session.shop,
    ...(status !== "all" ? { status } : {}),
    ...(search
      ? {
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
        }
      : {}),
  };

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
    ["errorMessage", "Note / Billing address"],
    ["id", "Invoice request ID"],
    ["cartToken", "Cart token"],
    ["checkoutToken", "Checkout token"],
  ];

  const rows = [
    columns.map(([, label]) => csvCell(label)).join(";"),
    ...requests.map((item) =>
      columns
        .map(([key]) => {
          if (key === "createdAt" || key === "updatedAt") return csvCell(formatDate(item[key]));
          if (["viesChecked", "viesValid", "reverseCharge", "taxExemptApplied"].includes(key)) {
            return csvCell(yesNo(item[key]));
          }
          return csvCell(item[key]);
        })
        .join(";")
    ),
  ];

  const today = new Date().toISOString().slice(0, 10);
  const csv = `\uFEFF${rows.join("\r\n")}`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoice-requests-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

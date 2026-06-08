import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function clean(value) {
  return String(value || "").trim();
}

function esc(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

function yesNo(value) {
  if (value === null || value === undefined) return "—";
  return value ? "Sì" : "No";
}

function row(label, value) {
  return `<tr><th>${esc(label)}</th><td>${esc(value || "—")}</td></tr>`;
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const id = clean(url.searchParams.get("id"));

  const item = await prisma.invoiceRequest.findFirst({
    where: {
      id,
      shop: session.shop,
    },
  });

  if (!id) {
    return new Response("ID richiesta mancante", { status: 400 });
  }

  if (!item) {
    return new Response("Richiesta non trovata", { status: 404 });
  }

  const customerName = [item.firstName, item.lastName].map(clean).filter(Boolean).join(" ");
  const today = formatDate(new Date());
  const documentTitle = `Facsimile richiesta fattura ${item.orderName || item.id}`;

  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(documentTitle)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px; font-family: Arial, Helvetica, sans-serif; color: #202223; background: #f6f6f7; }
    .page { max-width: 920px; margin: 0 auto; background: #fff; padding: 36px; border: 1px solid #dfe3e8; border-radius: 14px; }
    .topbar { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 28px; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    .muted { color: #6d7175; font-size: 13px; line-height: 1.5; }
    .badge { display: inline-block; padding: 5px 10px; border-radius: 999px; background: #e0f0ff; color: #2c6ecb; font-weight: 700; font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 24px 0; }
    .card { border: 1px solid #dfe3e8; border-radius: 12px; overflow: hidden; }
    .card h2 { margin: 0; padding: 12px 14px; background: #f6f6f7; font-size: 14px; text-transform: uppercase; letter-spacing: .04em; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { width: 38%; text-align: left; color: #6d7175; font-weight: 600; vertical-align: top; }
    th, td { padding: 10px 14px; border-top: 1px solid #f1f2f3; }
    pre { white-space: pre-wrap; word-break: break-word; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.55; margin: 0; padding: 14px; }
    .actions { max-width: 920px; margin: 0 auto 16px; display: flex; gap: 10px; justify-content: flex-end; }
    button { border: 0; background: #202223; color: white; padding: 10px 14px; border-radius: 8px; font-weight: 700; cursor: pointer; }
    .secondary { background: #fff; color: #202223; border: 1px solid #c9cccf; }
    .footer { margin-top: 26px; padding-top: 14px; border-top: 1px solid #dfe3e8; color: #6d7175; font-size: 12px; }
    @media print {
      body { background: #fff; padding: 0; }
      .actions { display: none; }
      .page { border: 0; border-radius: 0; max-width: none; padding: 18mm; }
      .grid { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="actions">
    <button type="button" onclick="window.print()">Stampa / salva PDF</button>
    <button type="button" class="secondary" onclick="window.close()">Chiudi</button>
  </div>

  <main class="page">
    <div class="topbar">
      <div>
        <h1>Facsimile richiesta fattura</h1>
        <div class="muted">Documento operativo interno per amministrazione/commercialista. Non è una fattura fiscale.</div>
      </div>
      <div style="text-align:right">
        <div class="badge">${esc(item.status || "draft")}</div>
        <div class="muted" style="margin-top:8px">Stampato il ${esc(today)}</div>
      </div>
    </div>

    <section class="grid">
      <div class="card">
        <h2>Richiesta</h2>
        <table>
          ${row("ID richiesta", item.id)}
          ${row("Tipo", item.invoiceType === "private" ? "Privato" : item.invoiceType === "company" ? "Azienda" : item.invoiceType)}
          ${row("Creata il", formatDate(item.createdAt))}
          ${row("Aggiornata il", formatDate(item.updatedAt))}
          ${row("Ordine", item.orderName)}
          ${row("Order ID", item.orderId)}
        </table>
      </div>

      <div class="card">
        <h2>Cliente</h2>
        <table>
          ${row("Email", item.customerEmail)}
          ${row("Nome", customerName)}
          ${row("Codice fiscale", item.fiscalCode)}
          ${row("Customer ID", item.customerId)}
        </table>
      </div>
    </section>

    <section class="grid">
      <div class="card">
        <h2>Dati azienda / fiscali</h2>
        <table>
          ${row("Azienda", item.companyName)}
          ${row("Paese", item.countryCode)}
          ${row("Partita IVA / VAT", item.vatNumber)}
          ${row("PEC", item.pec)}
          ${row("SDI", item.sdi)}
        </table>
      </div>

      <div class="card">
        <h2>VIES / reverse charge</h2>
        <table>
          ${row("VIES controllato", yesNo(item.viesChecked))}
          ${row("VIES valido", yesNo(item.viesValid))}
          ${row("Reverse charge", yesNo(item.reverseCharge))}
          ${row("Tax exempt applicato", yesNo(item.taxExemptApplied))}
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Note amministrative / Billing address / Products</h2>
      <pre>${esc(item.errorMessage || "—")}</pre>
    </section>

    <div class="footer">
      Generato da Invoice Request / VIES Check. Usare come facsimile operativo interno e verificare i dati fiscali prima dell’emissione della fattura.
    </div>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

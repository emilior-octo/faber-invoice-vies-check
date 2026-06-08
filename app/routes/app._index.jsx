import { useMemo } from "react";
import { data as json, useLoaderData, useLocation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const [requests, counts, recentOrdersCount, pendingCount] = await Promise.all([
    prisma.invoiceRequest.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.invoiceRequest.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: { status: true },
    }),
    prisma.invoiceRequest.count({
      where: {
        shop: session.shop,
        orderId: { not: null },
      },
    }),
    prisma.invoiceRequest.count({
      where: {
        shop: session.shop,
        status: { in: ["draft", "validated", "order_created", "failed"] },
      },
    }),
  ]);

  const countsByStatus = counts.reduce((acc, item) => {
    acc[item.status] = item._count.status;
    return acc;
  }, {});

  const totalCount = Object.values(countsByStatus).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );

  return json({
    shop: session.shop,
    totalCount,
    linkedOrdersCount: recentOrdersCount,
    pendingCount,
    counts: countsByStatus,
    recentRequests: requests.map(normalizeRequest),
  });
};

export default function Index() {
  const { shop, totalCount, linkedOrdersCount, pendingCount, counts, recentRequests } =
    useLoaderData();
  const location = useLocation();

  const invoiceRequestsHref = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const query = params.toString();
    return query ? `/app/invoice-requests?${query}` : "/app/invoice-requests";
  }, [location.search]);

  return (
    <s-page heading="Invoice Request / VIES Check">
      <s-link slot="primary-action" href={invoiceRequestsHref} variant="button">
        Apri richieste fattura
      </s-link>

      <s-section>
        <div style={styles.hero}>
          <div>
            <p style={styles.kicker}>Faber Coffee Machines</p>
            <h2 style={styles.heroTitle}>Gestione richieste fattura</h2>
            <p style={styles.heroText}>
              Monitora richieste da carrello, dati fiscali, VIES, reverse charge e
              collegamento con gli ordini Shopify.
            </p>
          </div>
          <div style={styles.statusPill}>App attiva</div>
        </div>
      </s-section>

      <s-section heading="Panoramica">
        <div style={styles.metricsGrid}>
          <MetricCard label="Richieste totali" value={totalCount} helper="Salvate nel database" />
          <MetricCard
            label="Ordini collegati"
            value={linkedOrdersCount}
            helper="Richieste sincronizzate da webhook"
          />
          <MetricCard
            label="Da controllare"
            value={pendingCount}
            helper="Draft, validate, order created o failed"
          />
          <MetricCard
            label="Processate"
            value={counts?.processed || 0}
            helper="Richieste già gestite"
          />
        </div>
      </s-section>

      <s-section heading="Workflow operativo">
        <div style={styles.workflowGrid}>
          <WorkflowStep
            number="1"
            title="Cliente richiede fattura"
            text="Il widget nel cart drawer registra privato o azienda e salva gli attributi nel carrello."
          />
          <WorkflowStep
            number="2"
            title="VIES e dati fiscali"
            text="Per le aziende UE l’app valida la partita IVA e prepara reverse charge quando applicabile."
          />
          <WorkflowStep
            number="3"
            title="Ordine Shopify"
            text="Il webhook collega ordine, cliente, email e dati fiscali alla richiesta."
          />
          <WorkflowStep
            number="4"
            title="Amministrazione"
            text="Il team controlla la richiesta e la marca come processata o respinta."
          />
        </div>
      </s-section>

      <s-section heading="Ultime richieste">
        {recentRequests.length === 0 ? (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-paragraph>Nessuna richiesta ancora registrata.</s-paragraph>
          </s-box>
        ) : (
          <div style={styles.tableWrapper}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Data</th>
                  <th style={styles.th}>Tipo</th>
                  <th style={styles.th}>Cliente / Azienda</th>
                  <th style={styles.th}>Ordine</th>
                  <th style={styles.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentRequests.map((request) => {
                  const orderUrl = getOrderUrl(shop, request.orderId);
                  return (
                    <tr key={request.id} style={styles.tr}>
                      <td style={styles.td}>{formatDate(request.createdAt)}</td>
                      <td style={styles.td}>{request.invoiceType || "—"}</td>
                      <td style={styles.td}>
                        <strong>
                          {request.companyName ||
                            [request.firstName, request.lastName].filter(Boolean).join(" ") ||
                            request.customerEmail ||
                            "—"}
                        </strong>
                        {request.customerEmail ? (
                          <span style={styles.mutedBlock}>{request.customerEmail}</span>
                        ) : null}
                      </td>
                      <td style={styles.td}>
                        {orderUrl ? (
                          <a href={orderUrl} target="_blank" rel="noreferrer" style={styles.link}>
                            {request.orderName || request.orderId}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={styles.td}>{request.status || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      <s-section slot="aside" heading="Stato app">
        <s-paragraph>
          <s-text>Store: </s-text>
          <s-text tone="subdued">{shop}</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>Proxy: </s-text>
          <s-text tone="subdued">/apps/invoice-request</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>Webhook: </s-text>
          <s-text tone="subdued">orders/create</s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Azioni rapide">
        <s-unordered-list>
          <s-list-item>
            <s-link href={invoiceRequestsHref}>Gestisci richieste fattura</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="https://fabercoffeemachines.com/apps/invoice-request/validate" target="_blank">
              Test app proxy
            </s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="https://faber-invoice-vies-check.onrender.com/apps/invoice-request/validate" target="_blank">
              Test backend diretto
            </s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

function MetricCard({ label, value, helper }) {
  return (
    <div style={styles.metricCard}>
      <span style={styles.metricLabel}>{label}</span>
      <strong style={styles.metricValue}>{value}</strong>
      <span style={styles.metricHelper}>{helper}</span>
    </div>
  );
}

function WorkflowStep({ number, title, text }) {
  return (
    <div style={styles.workflowStep}>
      <div style={styles.stepNumber}>{number}</div>
      <h3 style={styles.stepTitle}>{title}</h3>
      <p style={styles.stepText}>{text}</p>
    </div>
  );
}

const styles = {
  hero: {
    display: "flex",
    justifyContent: "space-between",
    gap: 24,
    alignItems: "flex-start",
    padding: 24,
    border: "1px solid #dfe3e8",
    borderRadius: 16,
    background: "linear-gradient(135deg, #fff 0%, #f6f6f7 100%)",
  },
  kicker: {
    margin: "0 0 6px",
    color: "#6d7175",
    fontSize: 13,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  heroTitle: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.15,
    color: "#202223",
  },
  heroText: {
    maxWidth: 720,
    margin: "10px 0 0",
    color: "#6d7175",
    fontSize: 15,
    lineHeight: 1.5,
  },
  statusPill: {
    flex: "0 0 auto",
    padding: "8px 12px",
    borderRadius: 999,
    background: "#e3f1df",
    color: "#108043",
    fontSize: 13,
    fontWeight: 700,
  },
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 12,
  },
  metricCard: {
    padding: 18,
    border: "1px solid #dfe3e8",
    borderRadius: 14,
    background: "#fff",
    display: "grid",
    gap: 6,
  },
  metricLabel: {
    color: "#6d7175",
    fontSize: 13,
  },
  metricValue: {
    color: "#202223",
    fontSize: 30,
    lineHeight: 1.1,
  },
  metricHelper: {
    color: "#6d7175",
    fontSize: 12,
  },
  workflowGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 12,
  },
  workflowStep: {
    padding: 18,
    border: "1px solid #dfe3e8",
    borderRadius: 14,
    background: "#fff",
  },
  stepNumber: {
    width: 30,
    height: 30,
    borderRadius: 999,
    display: "grid",
    placeItems: "center",
    background: "#202223",
    color: "#fff",
    fontWeight: 700,
    fontSize: 13,
    marginBottom: 12,
  },
  stepTitle: {
    margin: "0 0 6px",
    fontSize: 15,
    color: "#202223",
  },
  stepText: {
    margin: 0,
    color: "#6d7175",
    fontSize: 13,
    lineHeight: 1.45,
  },
  tableWrapper: {
    overflowX: "auto",
    border: "1px solid #dfe3e8",
    borderRadius: 12,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    background: "#fff",
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
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

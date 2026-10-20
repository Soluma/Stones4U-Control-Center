// Op rekening v1 — READ-ONLY overview of existing open on-account / pending
// orders (requirement 18). Queries only; it never changes an order. Prints
// order-level fields only (no customer names, e-mails, phone numbers or
// addresses), so the output can be shared for the go/no-go decision.
//
//   npx tsx scripts/on-account-open-orders-report.ts
//
// Self-contained on purpose (the app's client is server-only): its own
// read helper refuses any query containing "mutation", so this script
// cannot write to Shopify even by accident. Same env names as the app.
//
// Running it against PRODUCTION requires explicit approval first. It prints
// the target shop before anything else; check it.
import "dotenv/config";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} ontbreekt in de environment.`);
  return value;
}

let accessToken: string | null = null;

async function shopifyGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (/\bmutation\b/i.test(query)) throw new Error("Dit script is read-only: mutations zijn geweigerd.");
  const domain = env("SHOPIFY_SHOP_DOMAIN");
  if (!accessToken) {
    const tokenResponse = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env("SHOPIFY_CLIENT_ID"),
        client_secret: env("SHOPIFY_CLIENT_SECRET"),
      }),
    });
    const body = (await tokenResponse.json().catch(() => null)) as { access_token?: string } | null;
    if (!tokenResponse.ok || !body?.access_token) throw new Error(`Tokenverzoek mislukt (HTTP ${tokenResponse.status}).`);
    accessToken = body.access_token;
  }
  const response = await fetch(`https://${domain}/admin/api/${env("SHOPIFY_API_VERSION")}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await response.json()) as { data?: T; errors?: unknown };
  if (!response.ok || json.errors || !json.data) {
    throw new Error(`Shopify-query mislukt (HTTP ${response.status}): ${JSON.stringify(json.errors ?? null).slice(0, 300)}`);
  }
  return json.data;
}

type Row = {
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  tags: string[];
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  app: { name: string } | null;
  sourceName: string | null;
  totalPriceSet: { shopMoney: { amount: string } };
  totalOutstandingSet: { shopMoney: { amount: string } };
  paymentTerms: {
    paymentTermsType: string;
    dueInDays: number | null;
    overdue: boolean;
    paymentSchedules: { nodes: { dueAt: string | null; completedAt: string | null }[] };
  } | null;
  t: { value: string } | null;
  customer: { a: { value: string } | null } | null;
};

const ORDERS = `
  query OnAccountOpenOrders($after: String) {
    orders(first: 100, after: $after, sortKey: CREATED_AT, reverse: true,
      query: "financial_status:pending OR financial_status:partially_paid OR tag:op-rekening") {
      pageInfo { hasNextPage endCursor }
      nodes {
        name createdAt cancelledAt closed tags displayFinancialStatus displayFulfillmentStatus
        app { name } sourceName
        totalPriceSet { shopMoney { amount } } totalOutstandingSet { shopMoney { amount } }
        paymentTerms { paymentTermsType dueInDays overdue paymentSchedules(first: 2) { nodes { dueAt completedAt } } }
        t: metafield(namespace: "stones4u", key: "payment_term_days") { value }
        customer { a: metafield(namespace: "stones4u", key: "credit_allowed") { value } }
      }
    }
  }
`;

/** What v1 would think of this order — informational only, nothing is repaired. */
function assess(o: Row): string {
  if (o.cancelledAt) return "geannuleerd — negeren";
  if (Number(o.totalOutstandingSet.shopMoney.amount) <= 0) return "niets openstaand";
  const pt = o.paymentTerms;
  const terms = !pt
    ? "geen termijn"
    : pt.paymentTermsType === "FIXED"
      ? pt.overdue ? "FIXED, verlopen" : "FIXED, loopt"
      : pt.paymentTermsType === "FULFILLMENT"
        ? "FULFILLMENT-termijn (oud/tijdelijk) — afwijkend"
        : pt.paymentTermsType === "RECEIPT"
          ? "Due on receipt (oude Kassa-route) — afwijkend"
          : `${pt.paymentTermsType} — afwijkend`;
  if (!o.tags.includes("op-rekening")) return `${terms}; geen op-rekening-tag — niet automatisch meenemen`;
  return pt ? terms : "v1-rusttoestand (geen termijn)";
}

async function main() {
  const shop = await shopifyGraphQL<{ shop: { myshopifyDomain: string; plan: { partnerDevelopment: boolean } } }>(
    `{ shop { myshopifyDomain plan { partnerDevelopment } } }`,
  );
  console.log(`shop: ${shop.shop.myshopifyDomain} (partnerDevelopment=${shop.shop.plan.partnerDevelopment})`);

  const rows: Row[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Row[] } } =
      await shopifyGraphQL(ORDERS, { after });
    rows.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }

  console.log(
    ["order", "aangemaakt", "app", "financieel", "fulfilment", "tag", "termijn", "dueAt", "verlopen", "totaal", "open", "mf.termijn", "klant.credit", "beoordeling"].join("\t"),
  );
  for (const o of rows) {
    const pt = o.paymentTerms;
    console.log(
      [
        o.name,
        o.createdAt.slice(0, 10),
        o.app?.name ?? o.sourceName ?? "",
        o.displayFinancialStatus ?? "",
        o.displayFulfillmentStatus ?? "",
        o.tags.includes("op-rekening") ? "op-rekening" : "",
        pt ? `${pt.paymentTermsType}${pt.dueInDays ? `/${pt.dueInDays}` : ""}` : "geen",
        pt?.paymentSchedules.nodes[0]?.dueAt?.slice(0, 10) ?? "",
        pt?.overdue ? "ja" : "",
        o.totalPriceSet.shopMoney.amount,
        o.totalOutstandingSet.shopMoney.amount,
        o.t?.value ?? "",
        o.customer?.a?.value ?? "",
        assess(o),
      ].join("\t"),
    );
  }
  console.log(`totaal: ${rows.length} orders`);
}

main().catch((error) => {
  console.error("mislukt:", error instanceof Error ? error.message : error);
  process.exit(1);
});

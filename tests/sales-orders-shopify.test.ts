import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// listShopifyOrders (global, cursor-paged) and getDraftOrderNames (batched).
// Read-only queries only.

const ENV_KEYS = ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_API_VERSION", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"] as const;

function setShopifyEnv() {
  process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
  process.env.SHOPIFY_API_VERSION = "2026-07";
  process.env.SHOPIFY_CLIENT_ID = "test-client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "test-client-secret";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function graphqlFetch(data: unknown, captured: { query: string; variables: Record<string, unknown> }[]) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.headers && "X-Shopify-Access-Token" in (init.headers as Record<string, string>)) {
      captured.push(JSON.parse(String(init.body)));
      return jsonResponse({ data });
    }
    return jsonResponse({ access_token: "tok", expires_in: 3600 });
  });
}

function node(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/Order/${i}`,
    legacyResourceId: String(i),
    name: `#${i}`,
    createdAt: "2026-10-01T10:00:00Z",
    cancelledAt: null,
    displayFinancialStatus: "PENDING",
    displayFulfillmentStatus: "UNFULFILLED",
    currentTotalPriceSet: { shopMoney: { amount: "99.50", currencyCode: "EUR" } },
    customer: { id: "gid://shopify/Customer/7", displayName: "Klant Zeven" },
    ...overrides,
  };
}

describe("listShopifyOrders", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
    setShopifyEnv();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks Shopify for the first 50, newest first, as one read-only query", async () => {
    const captured: { query: string; variables: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      graphqlFetch({ orders: { pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: "a", endCursor: "b" }, edges: [{ node: node(1001) }, { node: node(1002, { customer: null, cancelledAt: "2026-10-02T00:00:00Z" }) }] } }, captured),
    );
    const { listShopifyOrders } = await import("@/integrations/shopify/orders");
    const page = await listShopifyOrders({ query: "financial_status:pending" });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.query).toMatch(/^\s*query OrdersPage/);
    expect(captured[0]!.query).not.toMatch(/mutation/);
    expect(captured[0]!.query).toMatch(/sortKey: CREATED_AT, reverse: true/);
    expect(captured[0]!.variables).toEqual({ first: 50, after: null, query: "financial_status:pending" });
    expect(page.pageInfo.endCursor).toBe("b");
    expect(page.orders[0]).toEqual({
      gid: "gid://shopify/Order/1001",
      legacyResourceId: "1001",
      name: "#1001",
      createdAt: "2026-10-01T10:00:00Z",
      cancelledAt: null,
      displayFinancialStatus: "PENDING",
      displayFulfillmentStatus: "UNFULFILLED",
      currentTotalPriceSet: { amount: "99.50", currencyCode: "EUR" },
      customer: { gid: "gid://shopify/Customer/7", displayName: "Klant Zeven" },
      adminUrl: expect.stringContaining("/orders/1001"),
    });
    expect(page.orders[1]!.customer).toBeNull();
    expect(page.orders[1]!.cancelledAt).toBe("2026-10-02T00:00:00Z");
  });

  it("passes the cursor for the next page, and pages back with last/before", async () => {
    const captured: { query: string; variables: Record<string, unknown> }[] = [];
    const data = { orders: { pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: "c", endCursor: "d" }, edges: [] } };
    vi.stubGlobal("fetch", graphqlFetch(data, captured));
    const { listShopifyOrders } = await import("@/integrations/shopify/orders");
    await listShopifyOrders({ after: "cursor-b" });
    await listShopifyOrders({ before: "cursor-c" });
    expect(captured[0]!.variables).toEqual({ first: 50, after: "cursor-b", query: null });
    expect(captured[1]!.variables).toEqual({ last: 50, before: "cursor-c", query: null });
  });
});

describe("getDraftOrderNames", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
    setShopifyEnv();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches all names in one nodes() query, deduped, draft-order GIDs only", async () => {
    const captured: { query: string; variables: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", graphqlFetch({ nodes: [{ id: "gid://shopify/DraftOrder/1", name: "#D1" }, null] }, captured));
    const { getDraftOrderNames } = await import("@/integrations/shopify/draft-orders");
    const names = await getDraftOrderNames(["gid://shopify/DraftOrder/1", "gid://shopify/DraftOrder/1", "gid://shopify/DraftOrder/2", "gid://shopify/Order/3"]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.variables).toEqual({ ids: ["gid://shopify/DraftOrder/1", "gid://shopify/DraftOrder/2"] });
    expect(names).toEqual(new Map([["gid://shopify/DraftOrder/1", "#D1"]]));
  });

  it("makes no request without draft orders, and fails soft on an error", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ errors: [{ message: "Access denied" }] }, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { getDraftOrderNames } = await import("@/integrations/shopify/draft-orders");
    expect(await getDraftOrderNames([])).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getDraftOrderNames(["gid://shopify/DraftOrder/1"])).toEqual(new Map());
  });
});

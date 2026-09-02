import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function tokenResponse() {
  return jsonResponse({ access_token: "tok_123", expires_in: 3600 });
}

/** Orders and draft orders are now two independent GraphQL requests (see
 * order-search.ts), issued concurrently via Promise.allSettled — so the
 * mock must route by request body content, not by call order. */
function routedFetchMock(handlers: { ordersBody?: unknown; draftOrdersBody?: unknown; draftOrdersStatus?: number }) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (body.includes("access_token") || !body.includes("query")) {
      // token endpoint uses a URLSearchParams body, not JSON — falls through here
    }
    if (init?.headers && "X-Shopify-Access-Token" in (init.headers as Record<string, string>)) {
      const parsed = JSON.parse(body) as { query: string };
      if (parsed.query.includes("SearchDraftOrders")) {
        return jsonResponse({ data: handlers.draftOrdersBody ?? { draftOrders: { edges: [] } } }, handlers.draftOrdersStatus ?? 200);
      }
      return jsonResponse({ data: handlers.ordersBody ?? { orders: { edges: [] } } });
    }
    return tokenResponse();
  });
}

describe("searchShopifyOrders", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges real orders and draft orders into one result list, tagged by kind", async () => {
    setShopifyEnv();
    const fetchMock = routedFetchMock({
      ordersBody: { orders: { edges: [{ node: { id: "gid://shopify/Order/1", name: "#1001", customer: { id: "gid://shopify/Customer/1", displayName: "Jan Jansen" } } }] } },
      draftOrdersBody: { draftOrders: { edges: [{ node: { id: "gid://shopify/DraftOrder/1", name: "#D1001", customer: { id: "gid://shopify/Customer/2", displayName: "Piet Pietersen" } } }] } },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchShopifyOrders } = await import("@/integrations/shopify/order-search");
    const results = await searchShopifyOrders("1001");

    expect(results).toEqual([
      { kind: "order", gid: "gid://shopify/Order/1", name: "#1001", customerGid: "gid://shopify/Customer/1", customerName: "Jan Jansen" },
      { kind: "draft_order", gid: "gid://shopify/DraftOrder/1", name: "#D1001", customerGid: "gid://shopify/Customer/2", customerName: "Piet Pietersen" },
    ]);
  });

  it("skips orders/draft orders with no attached Shopify customer — nowhere to navigate to", async () => {
    setShopifyEnv();
    const fetchMock = routedFetchMock({
      ordersBody: { orders: { edges: [{ node: { id: "gid://shopify/Order/2", name: "#1002", customer: null } }] } },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchShopifyOrders } = await import("@/integrations/shopify/order-search");
    const results = await searchShopifyOrders("1002");
    expect(results).toEqual([]);
  });

  it("returns an empty list, never throws, when nothing matches", async () => {
    setShopifyEnv();
    const fetchMock = routedFetchMock({});
    vi.stubGlobal("fetch", fetchMock);

    const { searchShopifyOrders } = await import("@/integrations/shopify/order-search");
    expect(await searchShopifyOrders("nonexistent")).toEqual([]);
  });

  it("sanitizes quotes/backslashes out of the search term before building the Shopify query string, for both requests", async () => {
    setShopifyEnv();
    const fetchMock = routedFetchMock({});
    vi.stubGlobal("fetch", fetchMock);

    const { searchShopifyOrders } = await import("@/integrations/shopify/order-search");
    await searchShopifyOrders('1001" OR status:any');

    const graphqlCalls = fetchMock.mock.calls.filter((call) => {
      const headers = call[1]?.headers as Record<string, string> | undefined;
      return headers && "X-Shopify-Access-Token" in headers;
    });
    expect(graphqlCalls).toHaveLength(2);
    for (const call of graphqlCalls) {
      const body = JSON.parse(String(call[1]?.body));
      expect(body.variables.query).not.toContain('"');
    }
  });

  it("scopes the orders query to the name field but uses a bare wildcard for draft orders — Shopify silently ignores a name:-scoped filter on the draftOrders connection", async () => {
    setShopifyEnv();
    const fetchMock = routedFetchMock({});
    vi.stubGlobal("fetch", fetchMock);

    const { searchShopifyOrders } = await import("@/integrations/shopify/order-search");
    await searchShopifyOrders("D570");

    const graphqlCalls = fetchMock.mock.calls.filter((call) => {
      const headers = call[1]?.headers as Record<string, string> | undefined;
      return headers && "X-Shopify-Access-Token" in headers;
    });
    const bodies = graphqlCalls.map((call) => JSON.parse(String(call[1]?.body)) as { query: string; variables: { query: string } });
    const ordersBody = bodies.find((b) => b.query.includes("SearchOrders("))!;
    const draftOrdersBody = bodies.find((b) => b.query.includes("SearchDraftOrders"))!;
    expect(ordersBody.variables.query).toBe("name:*D570*");
    expect(draftOrdersBody.variables.query).toBe("*D570*");
  });

  it("still returns real orders when draft orders are scope-denied — a shop without read_draft_orders must not lose order search entirely", async () => {
    setShopifyEnv();
    const fetchMock = routedFetchMock({
      ordersBody: { orders: { edges: [{ node: { id: "gid://shopify/Order/3", name: "#1003", customer: { id: "gid://shopify/Customer/3", displayName: "Klaas Klaassen" } } }] } },
      draftOrdersStatus: 403,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchShopifyOrders } = await import("@/integrations/shopify/order-search");
    const results = await searchShopifyOrders("1003");

    expect(results).toEqual([
      { kind: "order", gid: "gid://shopify/Order/3", name: "#1003", customerGid: "gid://shopify/Customer/3", customerName: "Klaas Klaassen" },
    ]);
  });

  it("still returns real draft orders when the (unrelated) orders request fails", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers && "X-Shopify-Access-Token" in headers) {
        const parsed = JSON.parse(body) as { query: string };
        if (parsed.query.includes("SearchDraftOrders")) {
          return jsonResponse({ data: { draftOrders: { edges: [{ node: { id: "gid://shopify/DraftOrder/9", name: "#D9", customer: { id: "gid://shopify/Customer/9", displayName: "Test Klant" } } }] } } });
        }
        return new Response("upstream error", { status: 500 });
      }
      return tokenResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchShopifyOrders } = await import("@/integrations/shopify/order-search");
    const results = await searchShopifyOrders("9");

    expect(results).toEqual([
      { kind: "draft_order", gid: "gid://shopify/DraftOrder/9", name: "#D9", customerGid: "gid://shopify/Customer/9", customerName: "Test Klant" },
    ]);
  });
});

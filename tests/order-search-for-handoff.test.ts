import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6E — same fetch-mocking technique as tests/shopify-order-search.test.ts,
// applied to the new staff "create an Order handoff" search
// (searchOrdersForHandoff, a separate, minimal-fields query from
// searchShopifyOrders — see order-search.ts's own doc comment for why).

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

function graphqlFetchMock(ordersBody: unknown) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers && "X-Shopify-Access-Token" in headers) {
      return jsonResponse({ data: ordersBody });
    }
    return tokenResponse();
  });
}

describe("searchOrdersForHandoff", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns minimal fields only — no customer name, no email, no phone, no address, no raw payload", async () => {
    setShopifyEnv();
    const fetchMock = graphqlFetchMock({
      orders: {
        edges: [
          {
            node: {
              id: "gid://shopify/Order/1",
              name: "#1001",
              createdAt: "2026-09-01T10:00:00Z",
              cancelledAt: null,
              displayFulfillmentStatus: "UNFULFILLED",
              customer: { id: "gid://shopify/Customer/1" },
              shippingAddress: { city: "Utrecht" },
              customAttributes: [],
            },
          },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    const results = await searchOrdersForHandoff("1001");

    expect(results).toEqual([
      {
        gid: "gid://shopify/Order/1",
        name: "#1001",
        createdAt: "2026-09-01T10:00:00Z",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: "gid://shopify/Customer/1",
        hasShippingAddress: true,
        requestedDeliveryDate: null,
      },
    ]);
    // No PII value of any kind exists on the result shape — note
    // "hasShippingAddress" (a boolean, not the address itself) legitimately
    // contains the substring "address", so this checks for actual leaked
    // content (an email's "@", a city name, a display name), not that word.
    const serialized = JSON.stringify(results);
    expect(serialized).not.toMatch(/email|telefoon|displayName|city|Utrecht/i);
    expect(serialized).not.toContain("@");
  });

  it("reports a cancelled Order", async () => {
    setShopifyEnv();
    const fetchMock = graphqlFetchMock({
      orders: {
        edges: [
          {
            node: {
              id: "gid://shopify/Order/2",
              name: "#1002",
              createdAt: "2026-09-01T10:00:00Z",
              cancelledAt: "2026-09-02T10:00:00Z",
              displayFulfillmentStatus: "UNFULFILLED",
              customer: null,
              shippingAddress: null,
              customAttributes: [],
            },
          },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    const [result] = await searchOrdersForHandoff("1002");
    expect(result!.isCancelled).toBe(true);
    expect(result!.customerGid).toBeNull();
    expect(result!.hasShippingAddress).toBe(false);
  });

  it("reports the actual requested_delivery_date value — not merely a boolean — so staff can be shown which date is already known (build instruction §2)", async () => {
    setShopifyEnv();
    const fetchMock = graphqlFetchMock({
      orders: {
        edges: [
          {
            node: {
              id: "gid://shopify/Order/3",
              name: "#1003",
              createdAt: "2026-09-01T10:00:00Z",
              cancelledAt: null,
              displayFulfillmentStatus: "FULFILLED",
              customer: { id: "gid://shopify/Customer/3" },
              shippingAddress: { city: "Utrecht" },
              customAttributes: [{ key: "requested_delivery_date", value: "2026-10-01" }],
            },
          },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    const [result] = await searchOrdersForHandoff("1003");
    expect(result!.requestedDeliveryDate).toBe("2026-10-01");
  });

  it("returns an empty list, never throws, when nothing matches", async () => {
    setShopifyEnv();
    const fetchMock = graphqlFetchMock({ orders: { edges: [] } });
    vi.stubGlobal("fetch", fetchMock);

    const { searchOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    expect(await searchOrdersForHandoff("nonexistent")).toEqual([]);
  });

  it("propagates a GraphQL/API failure rather than silently returning an empty result — the caller must be able to distinguish 'no matches' from 'search failed'", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers && "X-Shopify-Access-Token" in headers) {
        return new Response("upstream error", { status: 500 });
      }
      return tokenResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    await expect(searchOrdersForHandoff("1004")).rejects.toThrow();
  });

  it("sanitizes quotes/backslashes and scopes the query to the name field", async () => {
    setShopifyEnv();
    const fetchMock = graphqlFetchMock({ orders: { edges: [] } });
    vi.stubGlobal("fetch", fetchMock);

    const { searchOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    await searchOrdersForHandoff('1001" OR status:any');

    const graphqlCall = fetchMock.mock.calls.find((call) => {
      const headers = call[1]?.headers as Record<string, string> | undefined;
      return headers && "X-Shopify-Access-Token" in headers;
    })!;
    const body = JSON.parse(String(graphqlCall[1]?.body)) as { variables: { query: string } };
    expect(body.variables.query).toBe('name:*1001 OR status:any*');
  });

  it("never fetches the customer's displayName — only the customer GID, for server-side matching only", async () => {
    setShopifyEnv();
    const fetchMock = graphqlFetchMock({ orders: { edges: [] } });
    vi.stubGlobal("fetch", fetchMock);

    const { searchOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    await searchOrdersForHandoff("1001");

    const graphqlCall = fetchMock.mock.calls.find((call) => {
      const headers = call[1]?.headers as Record<string, string> | undefined;
      return headers && "X-Shopify-Access-Token" in headers;
    })!;
    const body = JSON.parse(String(graphqlCall[1]?.body)) as { query: string };
    expect(body.query).not.toMatch(/displayName/);
    expect(body.query).not.toMatch(/email/i);
    expect(body.query).not.toMatch(/phone/i);
  });
});

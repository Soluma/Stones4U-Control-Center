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

describe("getShopifyCustomerDraftOrders", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses draft orders, builds admin URLs, and carries the completed-order relation when present", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        data: {
          draftOrders: {
            edges: [
              {
                node: {
                  id: "gid://shopify/DraftOrder/1",
                  legacyResourceId: "1",
                  name: "#D1",
                  status: "COMPLETED",
                  createdAt: "2026-09-01T10:00:00Z",
                  updatedAt: "2026-09-02T10:00:00Z",
                  totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "EUR" } },
                  invoiceUrl: null,
                  order: { id: "gid://shopify/Order/9", legacyResourceId: "9", name: "#1009" },
                },
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getShopifyCustomerDraftOrders } = await import("@/integrations/shopify/draft-orders");
    const result = await getShopifyCustomerDraftOrders("gid://shopify/Customer/1");

    // draft orders live on the top-level `draftOrders` connection, filtered
    // by customer_id — Customer has no draftOrders field of its own.
    const graphqlCallBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(graphqlCallBody.variables.query).toBe("customer_id:1");

    expect(result.draftOrders).toHaveLength(1);
    const draftOrder = result.draftOrders[0]!;
    expect(draftOrder.status).toBe("COMPLETED");
    expect(draftOrder.adminUrl).toBe("https://test-shop.myshopify.com/admin/draft_orders/1");
    expect(draftOrder.completedOrder).toEqual({
      gid: "gid://shopify/Order/9",
      name: "#1009",
      adminUrl: "https://test-shop.myshopify.com/admin/orders/9",
    });
  });

  it("returns an empty list, never throws, when the customer has no draft orders", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ data: { draftOrders: { edges: [] } } }));
    vi.stubGlobal("fetch", fetchMock);

    const { getShopifyCustomerDraftOrders } = await import("@/integrations/shopify/draft-orders");
    const result = await getShopifyCustomerDraftOrders("gid://shopify/Customer/2");
    expect(result.draftOrders).toEqual([]);
  });

  it("returns an empty list without calling Shopify at all when the customer GID is malformed", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getShopifyCustomerDraftOrders } = await import("@/integrations/shopify/draft-orders");
    const result = await getShopifyCustomerDraftOrders("not-a-gid");
    expect(result.draftOrders).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a Shopify API failure as ShopifyApiError instead of swallowing it — caller is expected to catch it (fail-safe at the page level, not here)", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockImplementation(async () => new Response("upstream down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const { getShopifyCustomerDraftOrders } = await import("@/integrations/shopify/draft-orders");
    const { ShopifyApiError } = await import("@/integrations/shopify/errors");
    await expect(getShopifyCustomerDraftOrders("gid://shopify/Customer/3")).rejects.toBeInstanceOf(ShopifyApiError);
  });
});

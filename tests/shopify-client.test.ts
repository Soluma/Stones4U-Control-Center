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

describe("shopify client", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws a config error (never a generic crash) when env vars are missing", async () => {
    const { getShopifyConfig } = await import("@/integrations/shopify/client");
    const { ShopifyConfigError } = await import("@/integrations/shopify/errors");
    expect(() => getShopifyConfig()).toThrow(ShopifyConfigError);
  });

  it("reports isShopifyConfigured() accurately", async () => {
    const { isShopifyConfigured } = await import("@/integrations/shopify/client");
    expect(isShopifyConfigured()).toBe(false);
    setShopifyEnv();
    expect(isShopifyConfigured()).toBe(true);
  });

  it("acquires a token once and reuses it across two GraphQL calls (in-memory cache)", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok_123", expires_in: 3600 })) // token request
      .mockResolvedValueOnce(jsonResponse({ data: { shop: { name: "A" } } })) // first graphql call
      .mockResolvedValueOnce(jsonResponse({ data: { shop: { name: "A" } } })); // second graphql call, no new token request
    vi.stubGlobal("fetch", fetchMock);

    const { shopifyGraphQL } = await import("@/integrations/shopify/client");
    await shopifyGraphQL("query { shop { name } }");
    await shopifyGraphQL("query { shop { name } }");

    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 token + 2 graphql, never a 2nd token request
  });

  it("retries a transient (500) error up to the retry limit, then succeeds", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok_123", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ data: { shop: { name: "A" } } }));
    vi.stubGlobal("fetch", fetchMock);

    const { shopifyGraphQL } = await import("@/integrations/shopify/client");
    const result = await shopifyGraphQL<{ shop: { name: string } }>("query { shop { name } }");
    expect(result.shop.name).toBe("A");
  });

  it("does not retry a non-transient GraphQL user error", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok_123", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Field does not exist" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const { shopifyGraphQL } = await import("@/integrations/shopify/client");
    const { ShopifyApiError } = await import("@/integrations/shopify/errors");
    await expect(shopifyGraphQL("query { invalidField }")).rejects.toBeInstanceOf(ShopifyApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 token + 1 graphql, no retry
  });
});

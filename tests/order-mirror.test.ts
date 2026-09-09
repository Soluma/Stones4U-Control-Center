import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6B — mirrors tests/delivery-handoff-shopify.test.ts's
// mirrorRequestedDeliveryDateToShopify test pattern exactly, applied to
// the new Order mirror. Same mocking technique (vi.stubGlobal("fetch", …),
// vi.resetModules() + dynamic import per test) since order-mirror.ts calls
// the same shopifyGraphQL()/getAccessToken() machinery.

const ENV_KEYS = [
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_API_VERSION",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS",
] as const;

function setShopifyEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  process.env.SHOPIFY_SHOP_DOMAIN = overrides.SHOPIFY_SHOP_DOMAIN ?? "test-shop.myshopify.com";
  process.env.SHOPIFY_API_VERSION = "2026-07";
  process.env.SHOPIFY_CLIENT_ID = "test-client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "test-client-secret";
  if (overrides.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS !== undefined) {
    process.env.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS = overrides.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenResponse() {
  return jsonResponse({ access_token: "tok_123", expires_in: 3600 });
}

function shopIdentityResponse(myshopifyDomain: string) {
  return jsonResponse({ data: { shop: { myshopifyDomain } } });
}

describe("mirrorRequestedDeliveryDateToOrder — minimal query, read-merge-write", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setupAllowedEnv() {
    setShopifyEnv({
      SHOPIFY_SHOP_DOMAIN: "stones4u-dev.myshopify.com",
      SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: "stones4u-dev.myshopify.com",
    });
  }

  // F. wrong shop → blocked before mutation
  it("never mutates when the shop is not on the write allowlist — no order query, no orderUpdate mutation sent", async () => {
    setShopifyEnv({
      SHOPIFY_SHOP_DOMAIN: "stones4u.myshopify.com",
      SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: "stones4u-dev.myshopify.com",
    });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shopIdentityResponse("stones4u.myshopify.com"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToOrder } = await import("@/integrations/shopify/order-mirror");
    await expect(mirrorRequestedDeliveryDateToOrder("gid://shopify/Order/1", "2026-12-01")).rejects.toThrow(/shop identity mismatch/i);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // G. missing write allowlist → blocked
  it("fails closed with a config error when no write allowlist is set", async () => {
    setShopifyEnv({ SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToOrder } = await import("@/integrations/shopify/order-mirror");
    await expect(mirrorRequestedDeliveryDateToOrder("gid://shopify/Order/1", "2026-12-01")).rejects.toThrow(/SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A. [] + requested date → exactly one requested_delivery_date
  it("adds the attribute when none exist yet, using a query that never requests the nested customer object", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(jsonResponse({ data: { order: { id: "gid://shopify/Order/1", cancelledAt: null, customAttributes: [] } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { orderUpdate: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } } }));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToOrder } = await import("@/integrations/shopify/order-mirror");
    const result = await mirrorRequestedDeliveryDateToOrder("gid://shopify/Order/1", "2026-12-01");
    expect(result.orderGid).toBe("gid://shopify/Order/1");

    const orderQueryCall = fetchMock.mock.calls[2]!;
    const queryBody = JSON.parse(orderQueryCall[1].body as string);
    expect(queryBody.query).not.toMatch(/customer/i);
    expect(queryBody.query).toMatch(/customAttributes/);

    const mutationCall = fetchMock.mock.calls[3]!;
    const mutationBody = JSON.parse(mutationCall[1].body as string);
    expect(mutationBody.variables.input.customAttributes).toEqual([{ key: "requested_delivery_date", value: "2026-12-01" }]);
  });

  // B. existing unrelated attrs → preserved
  // C. existing requested_delivery_date old value → replaced
  // D. duplicate requested_delivery_date keys → canonical exactly one
  it("preserves unrelated existing attributes and replaces its own key exactly once, even if it appeared more than once", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            order: {
              id: "gid://shopify/Order/1",
              cancelledAt: null,
              customAttributes: [
                { key: "gift_message", value: "Hoi!" },
                { key: "requested_delivery_date", value: "2020-01-01" },
                { key: "requested_delivery_date", value: "2020-06-01" },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { orderUpdate: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } } }));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToOrder } = await import("@/integrations/shopify/order-mirror");
    await mirrorRequestedDeliveryDateToOrder("gid://shopify/Order/1", "2026-12-01");

    const mutationCall = fetchMock.mock.calls[3]!;
    const mutationBody = JSON.parse(mutationCall[1].body as string);
    const sentAttributes = mutationBody.variables.input.customAttributes as { key: string; value: string }[];

    expect(sentAttributes).toHaveLength(2);
    expect(sentAttributes).toContainEqual({ key: "gift_message", value: "Hoi!" });
    expect(sentAttributes).toContainEqual({ key: "requested_delivery_date", value: "2026-12-01" });
    expect(sentAttributes.filter((a) => a.key === "requested_delivery_date")).toHaveLength(1);
  });

  // E. same value → idempotent
  it("is idempotent — mirroring the same already-current value still succeeds and sends exactly one canonical key", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            order: {
              id: "gid://shopify/Order/1",
              cancelledAt: null,
              customAttributes: [{ key: "requested_delivery_date", value: "2026-12-01" }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { orderUpdate: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } } }));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToOrder } = await import("@/integrations/shopify/order-mirror");
    await mirrorRequestedDeliveryDateToOrder("gid://shopify/Order/1", "2026-12-01");

    const mutationCall = fetchMock.mock.calls[3]!;
    const mutationBody = JSON.parse(mutationCall[1].body as string);
    expect(mutationBody.variables.input.customAttributes).toEqual([{ key: "requested_delivery_date", value: "2026-12-01" }]);
  });

  // H. GraphQL userErrors → fail closed
  it("throws on an orderUpdate userErrors response", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(jsonResponse({ data: { order: { id: "gid://shopify/Order/1", cancelledAt: null, customAttributes: [] } } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            orderUpdate: {
              order: null,
              userErrors: [{ field: ["input", "customAttributes"], message: "Something went wrong" }],
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToOrder } = await import("@/integrations/shopify/order-mirror");
    await expect(mirrorRequestedDeliveryDateToOrder("gid://shopify/Order/1", "2026-12-01")).rejects.toThrow();
  });

  // I. network/API error → fail closed
  it("throws when the order no longer exists in Shopify", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(jsonResponse({ data: { order: null } }));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToOrder } = await import("@/integrations/shopify/order-mirror");
    await expect(mirrorRequestedDeliveryDateToOrder("gid://shopify/Order/999", "2026-12-01")).rejects.toThrow();
  });

  // J. cancelled Order → no mutation
  it("refuses to mutate a cancelled Order — no orderUpdate mutation sent", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(
        jsonResponse({ data: { order: { id: "gid://shopify/Order/1", cancelledAt: "2026-12-01T00:00:00Z", customAttributes: [] } } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToOrder } = await import("@/integrations/shopify/order-mirror");
    await expect(mirrorRequestedDeliveryDateToOrder("gid://shopify/Order/1", "2026-12-01")).rejects.toThrow(/geannuleerd/i);

    // Exactly token + identity + order-read — never a fourth call for the mutation.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

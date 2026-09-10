import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6L — writer-level tests against a mocked fetch, matching
// tests/delivery-handoff-shopify.test.ts's technique: prove the safety chain,
// the read-merge-write, the canonical spelling, and the post-write
// verification, without touching any real shop.

const ENV_KEYS = [
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_API_VERSION",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS",
] as const;

const KEY = "stones4u_fulfillment_mode";
const ORDER_GID = "gid://shopify/Order/9001";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function tokenResponse() {
  return jsonResponse({ access_token: "tok_123", expires_in: 3600 });
}
function shopIdentityResponse(domain: string) {
  return jsonResponse({ data: { shop: { myshopifyDomain: domain } } });
}
function orderReadResponse(customAttributes: { key: string; value: string }[], cancelledAt: string | null = null) {
  return jsonResponse({ data: { order: { id: ORDER_GID, name: "#9001", cancelledAt, customAttributes } } });
}
function orderUpdateResponse(customAttributes: { key: string; value: string }[]) {
  return jsonResponse({ data: { orderUpdate: { order: { id: ORDER_GID, customAttributes }, userErrors: [] } } });
}

function setAllowedEnv() {
  process.env.SHOPIFY_SHOP_DOMAIN = "stones4u-dev.myshopify.com";
  process.env.SHOPIFY_API_VERSION = "2026-07";
  process.env.SHOPIFY_CLIENT_ID = "test-client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "test-client-secret";
  process.env.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS = "stones4u-dev.myshopify.com";
}

describe("writeOrderFulfillmentMode", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Convenience: token + shop identity + order read + order update. */
  function mockChain(readAttrs: { key: string; value: string }[], writtenAttrs: { key: string; value: string }[]) {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(orderReadResponse(readAttrs))
      .mockResolvedValueOnce(orderUpdateResponse(writtenAttrs));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("never mutates when the shop is not on the write allowlist — no read, no mutation", async () => {
    setAllowedEnv();
    process.env.SHOPIFY_SHOP_DOMAIN = "stones4u.myshopify.com";
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shopIdentityResponse("stones4u.myshopify.com"));
    vi.stubGlobal("fetch", fetchMock);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    await expect(writeOrderFulfillmentMode(ORDER_GID, "DELIVERY")).rejects.toThrow(/shop identity mismatch/i);
    // Only token + identity check — the Order was never even read.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a cancelled Order after the guard but before any mutation", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(orderReadResponse([], "2026-09-01T00:00:00Z"));
    vi.stubGlobal("fetch", fetchMock);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    const { OrderCancelledError } = await import("@/integrations/shopify/errors");
    await expect(writeOrderFulfillmentMode(ORDER_GID, "DELIVERY")).rejects.toBeInstanceOf(OrderCancelledError);
    // token + identity + read, and nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("writes exactly one canonical attribute and preserves requested_delivery_date", async () => {
    setAllowedEnv();
    const existing = [
      { key: "requested_delivery_date", value: "2026-09-24" },
      { key: "some_other_app_key", value: "keep me" },
    ];
    const fetchMock = mockChain(existing, [...existing, { key: KEY, value: "CUSTOMER_PICKUP" }]);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    const result = await writeOrderFulfillmentMode(ORDER_GID, "CUSTOMER_PICKUP");

    expect(result.written).toBe(true);
    const mutationBody = JSON.parse(fetchMock.mock.calls[3]![1].body as string);
    const sent = mutationBody.variables.input.customAttributes;
    expect(sent).toContainEqual({ key: "requested_delivery_date", value: "2026-09-24" });
    expect(sent).toContainEqual({ key: "some_other_app_key", value: "keep me" });
    expect(sent.filter((a: { key: string }) => a.key === KEY)).toEqual([{ key: KEY, value: "CUSTOMER_PICKUP" }]);
  });

  it("skips the mutation entirely when the Order already holds exactly that canonical value", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(orderReadResponse([{ key: KEY, value: "DELIVERY" }]));
    vi.stubGlobal("fetch", fetchMock);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    const result = await writeOrderFulfillmentMode(ORDER_GID, "DELIVERY");

    expect(result.written).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3); // no mutation call
  });

  it("skips the mutation when clearing an Order that has no explicit key", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(orderReadResponse([{ key: "requested_delivery_date", value: "2026-09-24" }]));
    vi.stubGlobal("fetch", fetchMock);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    expect((await writeOrderFulfillmentMode(ORDER_GID, null)).written).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clearing removes only the fulfillment key and keeps everything else", async () => {
    setAllowedEnv();
    const keep = [{ key: "requested_delivery_date", value: "2026-09-24" }];
    const fetchMock = mockChain([...keep, { key: KEY, value: "CUSTOMER_PICKUP" }], keep);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    const result = await writeOrderFulfillmentMode(ORDER_GID, null);

    expect(result.written).toBe(true);
    // Removing the one legitimate key is not a duplicate repair — counting it
    // as one would inflate the duplicate metrics the audit metadata feeds.
    expect(result.duplicatesRemoved).toBe(0);
    const sent = JSON.parse(fetchMock.mock.calls[3]![1].body as string).variables.input.customAttributes;
    expect(sent).toEqual(keep);
  });

  it("clearing an Order that really does hold duplicates counts only the stray copies", async () => {
    setAllowedEnv();
    const fetchMock = mockChain(
      [
        { key: KEY, value: "DELIVERY" },
        { key: KEY, value: "RETAIL" },
      ],
      [],
    );
    expect(fetchMock).toBeDefined();

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    const result = await writeOrderFulfillmentMode(ORDER_GID, null);

    expect(result.written).toBe(true);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it("repairs duplicate keys down to exactly one canonical value", async () => {
    setAllowedEnv();
    const fetchMock = mockChain(
      [
        { key: KEY, value: "DELIVERY" },
        { key: KEY, value: "CUSTOMER_PICKUP" },
        { key: "requested_delivery_date", value: "2026-09-24" },
      ],
      [{ key: "requested_delivery_date", value: "2026-09-24" }, { key: KEY, value: "CUSTOMER_PICKUP" }],
    );

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    const result = await writeOrderFulfillmentMode(ORDER_GID, "CUSTOMER_PICKUP");

    expect(result.previous).toEqual({ status: "DUPLICATE" });
    expect(result.duplicatesRemoved).toBe(1);
    const sent = JSON.parse(fetchMock.mock.calls[3]![1].body as string).variables.input.customAttributes;
    expect(sent.filter((a: { key: string }) => a.key === KEY)).toHaveLength(1);
    expect(sent).toContainEqual({ key: "requested_delivery_date", value: "2026-09-24" });
  });

  it("rewrites a non-canonical stored spelling to the canonical one", async () => {
    setAllowedEnv();
    const fetchMock = mockChain([{ key: KEY, value: " delivery " }], [{ key: KEY, value: "DELIVERY" }]);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    const result = await writeOrderFulfillmentMode(ORDER_GID, "DELIVERY");

    expect(result.written).toBe(true);
    const sent = JSON.parse(fetchMock.mock.calls[3]![1].body as string).variables.input.customAttributes;
    expect(sent).toEqual([{ key: KEY, value: "DELIVERY" }]);
  });

  it("fails loudly when the write-back verification does not match what was requested", async () => {
    setAllowedEnv();
    // Shopify reports success but the attribute is not what we asked for.
    mockChain([], [{ key: KEY, value: "RETAIL" }]);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    await expect(writeOrderFulfillmentMode(ORDER_GID, "DELIVERY")).rejects.toThrow(/Verificatie na schrijven mislukt/);
  });

  it("fails loudly when an unrelated attribute was lost during the write", async () => {
    setAllowedEnv();
    mockChain(
      [{ key: "requested_delivery_date", value: "2026-09-24" }],
      [{ key: KEY, value: "DELIVERY" }], // the date silently vanished
    );

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    await expect(writeOrderFulfillmentMode(ORDER_GID, "DELIVERY")).rejects.toThrow(/overige customAttributes/);
  });

  it("fails loudly when the cleared key is somehow still present afterwards", async () => {
    setAllowedEnv();
    mockChain([{ key: KEY, value: "DELIVERY" }], [{ key: KEY, value: "DELIVERY" }]);

    const { writeOrderFulfillmentMode } = await import("@/integrations/shopify/order-fulfillment-mode-mirror");
    await expect(writeOrderFulfillmentMode(ORDER_GID, null)).rejects.toThrow(/Verificatie na schrijven mislukt/);
  });
});

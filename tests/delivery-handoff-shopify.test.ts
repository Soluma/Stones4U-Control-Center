import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("assertShopifyWriteAllowed — staging safety guard", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed with a config error when no allowlist is set at all", async () => {
    setShopifyEnv({ SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { assertShopifyWriteAllowed } = await import("@/integrations/shopify/write-safety-guard");
    await expect(assertShopifyWriteAllowed()).rejects.toThrow(/SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS/);
    // Fails before ever calling Shopify — no token request, no query.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the write when the live shop is on the allowlist (the approved dev store)", async () => {
    setShopifyEnv({
      SHOPIFY_SHOP_DOMAIN: "stones4u-dev.myshopify.com",
      SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: "stones4u-dev.myshopify.com",
    });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"));
    vi.stubGlobal("fetch", fetchMock);

    const { assertShopifyWriteAllowed } = await import("@/integrations/shopify/write-safety-guard");
    await expect(assertShopifyWriteAllowed()).resolves.toBeUndefined();
  });

  it("hard-fails when the live shop is the real production shop and only the dev store is on the allowlist — the exact staging-safety scenario", async () => {
    setShopifyEnv({
      // Simulates staging still configured against the real shop — the
      // documented current-state risk (docs/QUOTE-DELIVERY-DATE-PORTAL-DISCOVERY.md §3/§11).
      SHOPIFY_SHOP_DOMAIN: "stones4u.myshopify.com",
      SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: "stones4u-dev.myshopify.com",
    });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shopIdentityResponse("stones4u.myshopify.com"));
    vi.stubGlobal("fetch", fetchMock);

    const { assertShopifyWriteAllowed } = await import("@/integrations/shopify/write-safety-guard");
    await expect(assertShopifyWriteAllowed()).rejects.toThrow(/shop identity mismatch/i);
  });

  it("is case-insensitive and supports a comma-separated allowlist", async () => {
    setShopifyEnv({
      SHOPIFY_SHOP_DOMAIN: "stones4u-dev.myshopify.com",
      SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: "other-store.myshopify.com, Stones4U-Dev.MyShopify.com ",
    });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"));
    vi.stubGlobal("fetch", fetchMock);

    const { assertShopifyWriteAllowed } = await import("@/integrations/shopify/write-safety-guard");
    await expect(assertShopifyWriteAllowed()).resolves.toBeUndefined();
  });
});

describe("mirrorRequestedDeliveryDateToShopify — minimal query, read-merge-write", () => {
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

  it("never mutates when the shop is not on the write allowlist — no draftOrder query, no draftOrderUpdate mutation sent", async () => {
    setShopifyEnv({
      SHOPIFY_SHOP_DOMAIN: "stones4u.myshopify.com",
      SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: "stones4u-dev.myshopify.com",
    });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shopIdentityResponse("stones4u.myshopify.com"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToShopify } = await import("@/integrations/shopify/draft-order-mirror");
    await expect(mirrorRequestedDeliveryDateToShopify("gid://shopify/DraftOrder/1", "2026-12-01")).rejects.toThrow(/shop identity mismatch/i);

    // Exactly the token request + the identity check — never a third call
    // for the draft order itself.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adds the attribute when none exist yet, using a query that never requests the nested customer object", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(
        jsonResponse({ data: { draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceUrl: "https://stones4u-dev.myshopify.com/1/invoices/a", customAttributes: [] } } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { draftOrderUpdate: { draftOrder: { id: "gid://shopify/DraftOrder/1" }, userErrors: [] } } }));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToShopify } = await import("@/integrations/shopify/draft-order-mirror");
    const result = await mirrorRequestedDeliveryDateToShopify("gid://shopify/DraftOrder/1", "2026-12-01");

    expect(result.invoiceUrl).toBe("https://stones4u-dev.myshopify.com/1/invoices/a");

    const draftOrderQueryCall = fetchMock.mock.calls[2]!;
    const queryBody = JSON.parse(draftOrderQueryCall[1].body as string);
    expect(queryBody.query).not.toMatch(/customer/i);
    expect(queryBody.query).toMatch(/customAttributes/);
    expect(queryBody.query).toMatch(/invoiceUrl/);

    const mutationCall = fetchMock.mock.calls[3]!;
    const mutationBody = JSON.parse(mutationCall[1].body as string);
    expect(mutationBody.variables.input.customAttributes).toEqual([{ key: "requested_delivery_date", value: "2026-12-01" }]);
  });

  it("preserves unrelated existing attributes and replaces its own key exactly once — never a duplicate", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/1",
              invoiceUrl: "https://stones4u-dev.myshopify.com/1/invoices/a",
              customAttributes: [
                { key: "gift_message", value: "Hoi!" },
                { key: "requested_delivery_date", value: "2020-01-01" },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { draftOrderUpdate: { draftOrder: { id: "gid://shopify/DraftOrder/1" }, userErrors: [] } } }));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToShopify } = await import("@/integrations/shopify/draft-order-mirror");
    await mirrorRequestedDeliveryDateToShopify("gid://shopify/DraftOrder/1", "2026-12-01");

    const mutationCall = fetchMock.mock.calls[3]!;
    const mutationBody = JSON.parse(mutationCall[1].body as string);
    const sentAttributes = mutationBody.variables.input.customAttributes as { key: string; value: string }[];

    expect(sentAttributes).toHaveLength(2);
    expect(sentAttributes).toContainEqual({ key: "gift_message", value: "Hoi!" });
    expect(sentAttributes).toContainEqual({ key: "requested_delivery_date", value: "2026-12-01" });
    expect(sentAttributes.filter((a) => a.key === "requested_delivery_date")).toHaveLength(1);
  });

  it("throws on a draftOrderUpdate userErrors response and never returns an invoiceUrl", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(
        jsonResponse({ data: { draftOrder: { id: "gid://shopify/DraftOrder/1", invoiceUrl: "https://x/invoices/a", customAttributes: [] } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            draftOrderUpdate: {
              draftOrder: null,
              userErrors: [{ field: ["input", "customAttributes"], message: "Something went wrong" }],
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToShopify } = await import("@/integrations/shopify/draft-order-mirror");
    await expect(mirrorRequestedDeliveryDateToShopify("gid://shopify/DraftOrder/1", "2026-12-01")).rejects.toThrow();
  });

  it("throws when the draft order no longer exists in Shopify", async () => {
    setupAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(jsonResponse({ data: { draftOrder: null } }));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorRequestedDeliveryDateToShopify } = await import("@/integrations/shopify/draft-order-mirror");
    await expect(mirrorRequestedDeliveryDateToShopify("gid://shopify/DraftOrder/999", "2026-12-01")).rejects.toThrow();
  });
});

describe("searchDraftOrdersForHandoff — Phase 5A staff draft-order lookup", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is read-only — a single GraphQL query, never a mutation, and never queries the write-safety guard", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({ data: { draftOrders: { edges: [] } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { searchDraftOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    await searchDraftOrdersForHandoff("D24");

    // Exactly the token request + the search query — no third call (no
    // shop-identity/write-allowlist check, which only applies to writes).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const searchCall = fetchMock.mock.calls[1]!;
    const body = JSON.parse(searchCall[1].body as string);
    expect(body.query).toMatch(/draftOrders/);
    expect(body.query).not.toMatch(/mutation/i);
  });

  it("includes results without a Shopify customer (unlike the command-palette search) and maps status", async () => {
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
                  status: "OPEN",
                  customer: null,
                },
              },
              {
                node: {
                  id: "gid://shopify/DraftOrder/2",
                  legacyResourceId: "2",
                  name: "#D2",
                  status: "COMPLETED",
                  customer: { id: "gid://shopify/Customer/9", displayName: "Jan Jansen" },
                },
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { searchDraftOrdersForHandoff } = await import("@/integrations/shopify/order-search");
    const results = await searchDraftOrdersForHandoff("D");

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      gid: "gid://shopify/DraftOrder/1",
      legacyResourceId: "1",
      name: "#D1",
      status: "OPEN",
      customerGid: null,
      customerName: null,
    });
    expect(results[1]).toEqual({
      gid: "gid://shopify/DraftOrder/2",
      legacyResourceId: "2",
      name: "#D2",
      status: "COMPLETED",
      customerGid: "gid://shopify/Customer/9",
      customerName: "Jan Jansen",
    });
  });
});

describe("getOrderForHandoff — Phase 6B Order read client", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is read-only — a single GraphQL query, never a mutation, and never queries the write-safety guard", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        data: {
          order: {
            id: "gid://shopify/Order/1",
            name: "#1234",
            cancelledAt: null,
            displayFulfillmentStatus: "UNFULFILLED",
            customer: null,
            shippingAddress: null,
            customAttributes: [],
            fulfillmentOrders: { pageInfo: { hasNextPage: false }, edges: [] },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getOrderForHandoff } = await import("@/integrations/shopify/order-for-handoff");
    await getOrderForHandoff("gid://shopify/Order/1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const call = fetchMock.mock.calls[1]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.query).toMatch(/order\(/);
    expect(body.query).not.toMatch(/mutation/i);
  });

  it("maps every field correctly, including no-customer/no-shipping-address orders", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        data: {
          order: {
            id: "gid://shopify/Order/1",
            name: "#1234",
            cancelledAt: null,
            displayFulfillmentStatus: "UNFULFILLED",
            fullyPaid: false,
            customer: null,
            shippingAddress: null,
            customAttributes: [],
            fulfillmentOrders: { pageInfo: { hasNextPage: false }, edges: [] },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getOrderForHandoff } = await import("@/integrations/shopify/order-for-handoff");
    const result = await getOrderForHandoff("gid://shopify/Order/1");

    expect(result).toEqual({
      gid: "gid://shopify/Order/1",
      name: "#1234",
      isCancelled: false,
      fulfillmentStatus: "UNFULFILLED",
      customerGid: null,
      hasShippingAddress: false,
      hasRequestedDeliveryDateAlready: false,
      requestedDeliveryDate: null,
      fullyPaid: false,
      fulfillmentMode: "UNKNOWN",
    });
  });

  it("maps a cancelled, already-mirrored order with a customer and a shipping address correctly", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        data: {
          order: {
            id: "gid://shopify/Order/2",
            name: "#5678",
            cancelledAt: "2026-09-01T00:00:00Z",
            displayFulfillmentStatus: "FULFILLED",
            fullyPaid: true,
            customer: { id: "gid://shopify/Customer/9" },
            shippingAddress: { city: "Tilburg" },
            customAttributes: [{ key: "requested_delivery_date", value: "2026-09-01" }],
            // LOCAL is a genuine Shopify DeliveryMethodType (local delivery)
            // — it must map to DELIVERY, not CUSTOMER_PICKUP. This is the
            // explicit regression test for the Phase 6G mapping error
            // (build instruction §11 for Phase 6H).
            fulfillmentOrders: {
              pageInfo: { hasNextPage: false },
              edges: [{ node: { deliveryMethod: { methodType: "LOCAL" } } }],
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getOrderForHandoff } = await import("@/integrations/shopify/order-for-handoff");
    const result = await getOrderForHandoff("gid://shopify/Order/2");

    expect(result).toEqual({
      gid: "gid://shopify/Order/2",
      name: "#5678",
      isCancelled: true,
      fulfillmentStatus: "FULFILLED",
      customerGid: "gid://shopify/Customer/9",
      hasShippingAddress: true,
      hasRequestedDeliveryDateAlready: true,
      requestedDeliveryDate: "2026-09-01",
      fullyPaid: true,
      fulfillmentMode: "DELIVERY",
    });
  });

  it("a split Order whose FulfillmentOrders disagree (shipped + collected) reads as UNKNOWN, never as DELIVERY", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        data: {
          order: {
            id: "gid://shopify/Order/3",
            name: "#5679",
            cancelledAt: null,
            displayFulfillmentStatus: "UNFULFILLED",
            fullyPaid: true,
            customer: null,
            shippingAddress: { city: "Tilburg" },
            customAttributes: [],
            fulfillmentOrders: {
              pageInfo: { hasNextPage: false },
              edges: [
                { node: { deliveryMethod: { methodType: "SHIPPING" } } },
                { node: { deliveryMethod: { methodType: "PICK_UP" } } },
              ],
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getOrderForHandoff } = await import("@/integrations/shopify/order-for-handoff");
    const result = await getOrderForHandoff("gid://shopify/Order/3");

    expect(result?.fulfillmentMode).toBe("UNKNOWN");
  });

  it("a truncated fulfillmentOrders connection reads as UNKNOWN even when every visible FulfillmentOrder agrees", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      jsonResponse({
        data: {
          order: {
            id: "gid://shopify/Order/4",
            name: "#5680",
            cancelledAt: null,
            displayFulfillmentStatus: "UNFULFILLED",
            fullyPaid: true,
            customer: null,
            shippingAddress: { city: "Tilburg" },
            customAttributes: [],
            fulfillmentOrders: {
              pageInfo: { hasNextPage: true },
              edges: [{ node: { deliveryMethod: { methodType: "SHIPPING" } } }],
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getOrderForHandoff } = await import("@/integrations/shopify/order-for-handoff");
    const result = await getOrderForHandoff("gid://shopify/Order/4");

    expect(result?.fulfillmentMode).toBe("UNKNOWN");
  });

  it("returns null for an unknown/nonexistent Order, never throws", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({ data: { order: null } }));
    vi.stubGlobal("fetch", fetchMock);

    const { getOrderForHandoff } = await import("@/integrations/shopify/order-for-handoff");
    await expect(getOrderForHandoff("gid://shopify/Order/999")).resolves.toBeNull();
  });
});

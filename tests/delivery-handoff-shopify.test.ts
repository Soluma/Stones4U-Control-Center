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

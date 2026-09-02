import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "OFFERTEAPP_API_BASE_URL",
  "OFFERTEAPP_SERVICE_TOKEN",
  "S4U_QUOTE_APP_API_BASE_URL",
  "S4U_QUOTE_APP_SERVICE_TOKEN",
] as const;

function setEnv() {
  process.env.OFFERTEAPP_API_BASE_URL = "https://offerteapp.fly.dev";
  process.env.OFFERTEAPP_SERVICE_TOKEN = "offerteapp-token";
  process.env.S4U_QUOTE_APP_API_BASE_URL = "https://s4u-quote-app.fly.dev";
  process.env.S4U_QUOTE_APP_SERVICE_TOKEN = "s4u-token";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function quote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    externalId: "quote-1",
    displayNumber: "OFF-2026-0903-001",
    email: "klant@voorbeeld.nl",
    phone: "31612345678",
    shopifyCustomerGid: null,
    shopifyDraftOrderGid: null,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    status: "sent",
    total: "123.45",
    currency: "EUR",
    sourceSystem: "OFFERTEAPP",
    adminUrl: "https://offerteapp.fly.dev/overzichten",
    ...overrides,
  };
}

vi.mock("@/platform/db/prisma", () => ({
  prisma: {
    customerProfile: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/modules/matching/matching.service", () => ({
  getMatchesForCustomer: vi.fn().mockResolvedValue([]),
}));

describe("createQuotesAdapter", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is disabled when neither sibling app is configured", async () => {
    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    const adapter = createQuotesAdapter();
    expect(adapter.status()).toEqual({ available: false, reason: expect.any(String) });
    expect(await adapter.getQuotesForCustomer({})).toEqual([]);
  });

  it("tier 1: resolves by Shopify Customer GID against OfferteApp only (s4u-quote-app has no such field)", async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ quotes: [quote()] }));
    vi.stubGlobal("fetch", fetchMock);

    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    const result = await createQuotesAdapter().getQuotesForCustomer({
      shopifyCustomerGid: "gid://shopify/Customer/25413296554316",
      email: "klant@voorbeeld.nl",
    });

    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only OfferteApp queried, tier 1 succeeded
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("shopifyCustomerId=25413296554316");
  });

  it("tier 3: falls back to email when GID tier finds nothing", async () => {
    setEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ quotes: [] })) // tier 1, OfferteApp by GID
      .mockResolvedValueOnce(jsonResponse({ quotes: [quote({ sourceSystem: "OFFERTEAPP" })] })) // tier 3, OfferteApp by email
      .mockResolvedValueOnce(jsonResponse({ quotes: [] })); // tier 3, s4u-quote-app by email
    vi.stubGlobal("fetch", fetchMock);

    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    const result = await createQuotesAdapter().getQuotesForCustomer({
      shopifyCustomerGid: "gid://shopify/Customer/999",
      email: "klant@voorbeeld.nl",
    });

    expect(result).toHaveLength(1);
  });

  it("tier 4: falls back to phone only when email tier also finds nothing", async () => {
    setEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ quotes: [] })) // tier 3 email, OfferteApp
      .mockResolvedValueOnce(jsonResponse({ quotes: [] })) // tier 3 email, s4u
      .mockResolvedValueOnce(jsonResponse({ quotes: [quote({ sourceSystem: "S4U_QUOTE_APP", email: null })] })) // tier 4 phone, OfferteApp
      .mockResolvedValueOnce(jsonResponse({ quotes: [] })); // tier 4 phone, s4u
    vi.stubGlobal("fetch", fetchMock);

    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    const result = await createQuotesAdapter().getQuotesForCustomer({ email: "nobody@nowhere.example", phone: "31612345678" });

    expect(result).toHaveLength(1);
  });

  it("never falls through to a weaker tier once a stronger one finds results", async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ quotes: [quote()] })); // tier 1 GID succeeds
    vi.stubGlobal("fetch", fetchMock);

    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    await createQuotesAdapter().getQuotesForCustomer({
      shopifyCustomerGid: "gid://shopify/Customer/1",
      email: "klant@voorbeeld.nl",
      phone: "31612345678",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // email/phone tiers never queried
  });

  it("dedupes two quotes from different sources that reference the same Shopify draft order, preferring OfferteApp", async () => {
    setEnv();
    const draftGid = "gid://shopify/DraftOrder/123";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ quotes: [quote({ sourceSystem: "OFFERTEAPP", externalId: "off-1", shopifyDraftOrderGid: draftGid })] }))
      .mockResolvedValueOnce(jsonResponse({ quotes: [quote({ sourceSystem: "S4U_QUOTE_APP", externalId: "s4u-1", shopifyDraftOrderGid: draftGid })] }));
    vi.stubGlobal("fetch", fetchMock);

    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    const result = await createQuotesAdapter().getQuotesForCustomer({ email: "klant@voorbeeld.nl" });

    expect(result).toHaveLength(1);
    expect(result[0]!.sourceSystem).toBe("OFFERTEAPP");
  });

  it("does not dedupe quotes without a shared draft order — both are kept", async () => {
    setEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ quotes: [quote({ sourceSystem: "OFFERTEAPP", externalId: "off-1" })] }))
      .mockResolvedValueOnce(jsonResponse({ quotes: [quote({ sourceSystem: "S4U_QUOTE_APP", externalId: "s4u-1" })] }));
    vi.stubGlobal("fetch", fetchMock);

    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    const result = await createQuotesAdapter().getQuotesForCustomer({ email: "klant@voorbeeld.nl" });

    expect(result).toHaveLength(2);
  });

  it("degrades to [] (never throws) when a source is unreachable", async () => {
    setEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    );
    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    const result = await createQuotesAdapter().getQuotesForCustomer({ email: "klant@voorbeeld.nl" });
    expect(result).toEqual([]);
  });

  it("preserves status and amount fields verbatim", async () => {
    setEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ quotes: [quote({ status: "invoiced", total: "999.00", currency: "EUR" })] }));
    vi.stubGlobal("fetch", fetchMock);

    const { createQuotesAdapter } = await import("@/integrations/quotes/adapter");
    const result = await createQuotesAdapter().getQuotesForCustomer({
      shopifyCustomerGid: "gid://shopify/Customer/1",
    });

    expect(result[0]).toMatchObject({ status: "invoiced", total: "999.00", currency: "EUR" });
  });
});

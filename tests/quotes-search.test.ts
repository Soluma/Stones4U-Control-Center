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

const findUnique = vi.fn();
const findFirst = vi.fn();
vi.mock("@/platform/db/prisma", () => ({
  prisma: { customerProfile: { findUnique: (...a: unknown[]) => findUnique(...a), findFirst: (...a: unknown[]) => findFirst(...a) } },
}));
vi.mock("@/modules/matching/matching.service", () => ({ getMatchesForCustomer: vi.fn().mockResolvedValue([]) }));

describe("searchQuotesByNumber", () => {
  beforeEach(() => {
    vi.resetModules();
    findUnique.mockReset();
    findFirst.mockReset();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a quote with a Shopify Customer GID to its existing CustomerProfile", async () => {
    setEnv();
    findUnique.mockResolvedValueOnce({ id: "profile-1", displayName: "Fons Verkoelen", companyName: null });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            quotes: [
              {
                externalId: "quote-1",
                displayNumber: "OFF-2026-0903-001",
                email: "fons@soluma.nl",
                phone: null,
                shopifyCustomerGid: "gid://shopify/Customer/25413296554316",
                shopifyDraftOrderGid: null,
                createdAt: "2026-09-01T00:00:00Z",
                updatedAt: "2026-09-01T00:00:00Z",
                status: "sent",
                total: "10.00",
                currency: "EUR",
                sourceSystem: "OFFERTEAPP",
                adminUrl: "https://offerteapp.fly.dev/overzichten",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ quotes: [] })),
    );

    const { searchQuotesByNumber } = await import("@/integrations/quotes/adapter");
    const results = await searchQuotesByNumber("0903-001");

    expect(results).toEqual([
      { customerProfileId: "profile-1", customerName: "Fons Verkoelen", externalId: "quote-1", displayNumber: "OFF-2026-0903-001", sourceSystem: "OFFERTEAPP" },
    ]);
    expect(findUnique).toHaveBeenCalledWith({
      where: { shopifyCustomerGid: "gid://shopify/Customer/25413296554316" },
      select: { id: true, displayName: true, companyName: true, customerTypeOverride: true },
    });
  });

  it("falls back to matching by normalized email when no Shopify GID is present", async () => {
    setEnv();
    findFirst.mockResolvedValueOnce({ id: "profile-2", displayName: null, companyName: "Bouwbedrijf X" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ quotes: [] }))
        .mockResolvedValueOnce(
          jsonResponse({
            quotes: [
              {
                externalId: "quote-2",
                displayNumber: "Q-2026-0903-002",
                email: "Info@Bouwbedrijf-X.nl",
                phone: null,
                shopifyCustomerGid: null,
                shopifyDraftOrderGid: null,
                createdAt: "2026-09-02T00:00:00Z",
                updatedAt: "2026-09-02T00:00:00Z",
                status: "new",
                total: "50.00",
                currency: "EUR",
                sourceSystem: "S4U_QUOTE_APP",
                adminUrl: "https://s4u-quote-app.fly.dev/app/quotes/quote-2",
              },
            ],
          }),
        ),
    );

    const { searchQuotesByNumber } = await import("@/integrations/quotes/adapter");
    const results = await searchQuotesByNumber("0903-002");

    expect(results).toEqual([
      { customerProfileId: "profile-2", customerName: "Bouwbedrijf X", externalId: "quote-2", displayNumber: "Q-2026-0903-002", sourceSystem: "S4U_QUOTE_APP" },
    ]);
    expect(findFirst).toHaveBeenCalledWith({
      where: { email: { equals: "info@bouwbedrijf-x.nl", mode: "insensitive" } },
      select: { id: true, displayName: true, companyName: true, customerTypeOverride: true },
    });
  });

  it("skips a quote that resolves to no existing CustomerProfile — nowhere to navigate to", async () => {
    setEnv();
    findFirst.mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            quotes: [
              {
                externalId: "quote-3",
                displayNumber: "OFF-2026-0903-003",
                email: "onbekend@nergens.example",
                phone: null,
                shopifyCustomerGid: null,
                shopifyDraftOrderGid: null,
                createdAt: "2026-09-03T00:00:00Z",
                updatedAt: "2026-09-03T00:00:00Z",
                status: "draft",
                total: "0.00",
                currency: "EUR",
                sourceSystem: "OFFERTEAPP",
                adminUrl: "https://offerteapp.fly.dev/overzichten",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ quotes: [] })),
    );

    const { searchQuotesByNumber } = await import("@/integrations/quotes/adapter");
    expect(await searchQuotesByNumber("0903-003")).toEqual([]);
  });

  it("returns [] without calling fetch when neither sibling app is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { searchQuotesByNumber } = await import("@/integrations/quotes/adapter");
    expect(await searchQuotesByNumber("anything")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

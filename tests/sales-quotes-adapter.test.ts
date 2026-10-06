import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FederatedQuotesAdapter.listQuotes — the global /quotes search. Same bearer
// auth, timeout and draft-order dedup as getQuotesForCustomer.

const ENV_KEYS = ["OFFERTEAPP_API_BASE_URL", "OFFERTEAPP_SERVICE_TOKEN", "S4U_QUOTE_APP_API_BASE_URL", "S4U_QUOTE_APP_SERVICE_TOKEN"] as const;

function setEnv(which: "both" | "offerteapp" | "none" = "both") {
  if (which !== "none") {
    process.env.OFFERTEAPP_API_BASE_URL = "https://offerteapp.fly.dev";
    process.env.OFFERTEAPP_SERVICE_TOKEN = "offerteapp-token";
  }
  if (which === "both") {
    process.env.S4U_QUOTE_APP_API_BASE_URL = "https://s4u-quote-app.fly.dev";
    process.env.S4U_QUOTE_APP_SERVICE_TOKEN = "s4u-token";
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function quote(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "q-1",
    displayNumber: "OFF-2026-0903-001",
    email: "klant@voorbeeld.nl",
    phone: null,
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

vi.mock("@/platform/db/prisma", () => ({ prisma: { customerProfile: { findUnique: vi.fn(), findFirst: vi.fn() } } }));
vi.mock("@/modules/matching/matching.service", () => ({ getMatchesForCustomer: vi.fn().mockResolvedValue([]) }));

type Handler = (url: URL) => Response | Promise<Response>;

function routedFetch(handlers: { offerteapp?: Handler; s4u?: Handler }) {
  return vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
    const url = new URL(String(input));
    const handler = url.hostname.startsWith("offerteapp") ? handlers.offerteapp : handlers.s4u;
    if (!handler) throw new Error("unexpected host " + url.hostname);
    return handler(url);
  });
}

async function load() {
  return import("@/integrations/quotes/adapter");
}

describe("quoteSearchParams", () => {
  it("maps an e-mail to an exact e-mail lookup, other text to a number search, phone-like text also to phone", async () => {
    const { quoteSearchParams } = await load();
    expect(quoteSearchParams("Klant@Voorbeeld.NL")).toEqual({ email: "klant@voorbeeld.nl" });
    expect(quoteSearchParams("OFF-2026-0903")).toEqual({ number: "OFF-2026-0903" });
    expect(quoteSearchParams("+31 6 1234 5678")).toEqual({ number: "+31 6 1234 5678", phone: "+31 6 1234 5678" });
    expect(quoteSearchParams(" a ")).toBeNull();
    expect(quoteSearchParams("")).toBeNull();
  });
});

describe("FederatedQuotesAdapter.listQuotes", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("searches both sources once each with their own bearer token and shows both", async () => {
    setEnv();
    const fetchMock = routedFetch({
      offerteapp: () => jsonResponse({ quotes: [quote()] }),
      s4u: () => jsonResponse({ quotes: [quote({ externalId: "s-1", displayNumber: "Q-1001", sourceSystem: "S4U_QUOTE_APP", adminUrl: "https://s4u-quote-app.fly.dev/app/quotes/s-1", createdAt: "2026-09-05T10:00:00Z" })] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createQuotesAdapter } = await load();

    const result = await createQuotesAdapter().listQuotes({ mode: "search", term: "klant@voorbeeld.nl" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls.map(([u, init]) => ({ url: new URL(String(u)), auth: init!.headers as Record<string, string> }));
    expect(calls.find((c) => c.url.hostname.startsWith("offerteapp"))!.auth.Authorization).toBe("Bearer offerteapp-token");
    expect(calls.find((c) => c.url.hostname.startsWith("s4u"))!.auth.Authorization).toBe("Bearer s4u-token");
    for (const c of calls) {
      expect(c.url.pathname).toBe("/api/integrations/control-center/quotes");
      expect(c.url.searchParams.get("email")).toBe("klant@voorbeeld.nl");
    }
    expect(result.quotes.map((q) => q.sourceSystem)).toEqual(["S4U_QUOTE_APP", "OFFERTEAPP"]); // newest first
    expect(result.sources).toEqual({ OFFERTEAPP: "ok", S4U_QUOTE_APP: "ok" });
    // adminUrl is passed through untouched, per source
    expect(result.quotes.find((q) => q.sourceSystem === "S4U_QUOTE_APP")!.adminUrl).toBe("https://s4u-quote-app.fly.dev/app/quotes/s-1");
    expect(result.quotes.find((q) => q.sourceSystem === "OFFERTEAPP")!.adminUrl).toBe("https://offerteapp.fly.dev/overzichten");
  });

  it("dedupes the same Shopify draft order across both sources, keeping the OfferteApp record", async () => {
    setEnv();
    const draft = "gid://shopify/DraftOrder/570";
    vi.stubGlobal(
      "fetch",
      routedFetch({
        offerteapp: () => jsonResponse({ quotes: [quote({ shopifyDraftOrderGid: draft })] }),
        s4u: () => jsonResponse({ quotes: [quote({ externalId: "s-1", sourceSystem: "S4U_QUOTE_APP", shopifyDraftOrderGid: draft }), quote({ externalId: "s-2", sourceSystem: "S4U_QUOTE_APP" })] }),
      }),
    );
    const { createQuotesAdapter } = await load();
    const result = await createQuotesAdapter().listQuotes({ mode: "search", term: "OFF-2026" });
    expect(result.quotes).toHaveLength(2);
    expect(result.quotes.find((q) => q.shopifyDraftOrderGid === draft)!.sourceSystem).toBe("OFFERTEAPP");
  });

  it("sends a number search (and phone for phone-like input) as one request per source", async () => {
    setEnv();
    const fetchMock = routedFetch({ offerteapp: () => jsonResponse({ quotes: [] }), s4u: () => jsonResponse({ quotes: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const { createQuotesAdapter } = await load();
    await createQuotesAdapter().listQuotes({ mode: "search", term: "0612345678" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("number")).toBe("0612345678");
    expect(url.searchParams.get("phone")).toBe("0612345678");
  });

  it("keeps the other source when one is offline, and says which one", async () => {
    setEnv();
    vi.stubGlobal(
      "fetch",
      routedFetch({ offerteapp: () => jsonResponse({ error: "boom" }, 500), s4u: () => jsonResponse({ quotes: [quote({ externalId: "s-1", sourceSystem: "S4U_QUOTE_APP" })] }) }),
    );
    const { createQuotesAdapter } = await load();
    const result = await createQuotesAdapter().listQuotes({ mode: "search", term: "OFF" });
    expect(result.sources).toEqual({ OFFERTEAPP: "unavailable", S4U_QUOTE_APP: "ok" });
    expect(result.quotes).toHaveLength(1);
  });

  it("reports both sources unavailable (timeouts/network errors) without throwing", async () => {
    setEnv();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        offerteapp: () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        s4u: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    );
    const { createQuotesAdapter } = await load();
    const result = await createQuotesAdapter().listQuotes({ mode: "search", term: "OFF" });
    expect(result.sources).toEqual({ OFFERTEAPP: "unavailable", S4U_QUOTE_APP: "unavailable" });
    expect(result.quotes).toEqual([]);
  });

  it("flags a source that returned the 25-result maximum", async () => {
    setEnv();
    const many = Array.from({ length: 25 }, (_, i) => quote({ externalId: `q-${i}` }));
    vi.stubGlobal("fetch", routedFetch({ offerteapp: () => jsonResponse({ quotes: many }), s4u: () => jsonResponse({ quotes: [] }) }));
    const { createQuotesAdapter, QUOTE_RESULTS_PER_SOURCE } = await load();
    const result = await createQuotesAdapter().listQuotes({ mode: "search", term: "OFF" });
    expect(QUOTE_RESULTS_PER_SOURCE).toBe(25);
    expect(result.limitReached).toEqual({ OFFERTEAPP: true, S4U_QUOTE_APP: false });
  });

  it("never calls a sibling for a too-short term, and marks an unconfigured source", async () => {
    setEnv("offerteapp");
    const fetchMock = routedFetch({ offerteapp: () => jsonResponse({ quotes: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const { createQuotesAdapter } = await load();
    const result = await createQuotesAdapter().listQuotes({ mode: "search", term: "x" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.sources).toEqual({ OFFERTEAPP: "ok", S4U_QUOTE_APP: "not_configured" });
  });

  it("the disabled adapter (nothing configured) reports both sources as not configured", async () => {
    setEnv("none");
    const { createQuotesAdapter } = await load();
    const result = await createQuotesAdapter().listQuotes({ mode: "search", term: "OFF-2026" });
    expect(result).toEqual({
      quotes: [],
      sources: { OFFERTEAPP: "not_configured", S4U_QUOTE_APP: "not_configured" },
      limitReached: { OFFERTEAPP: false, S4U_QUOTE_APP: false },
    });
  });
});

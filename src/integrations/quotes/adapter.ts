import "server-only";
import { prisma } from "@/platform/db/prisma";
import { getMatchesForCustomer } from "@/modules/matching/matching.service";
import { normalizeEmail } from "@/lib/email";

// Quotes adapter (OfferteApp + s4u-quote-app) — read-only projection into
// Customer 360's Commercieel tab and the Activity Timeline.
//
// STATUS: ENABLED in Phase 3b. Both sibling apps now expose
// GET /api/integrations/control-center/quotes[?shopifyCustomerId=&email=&phone=]
// (OfferteApp) / [?email=&phone=] (s4u-quote-app), each guarded by its own
// dedicated CRM_SERVICE_TOKEN bearer credential. The two apps are
// independent, uncoupled quote sources (docs/platform-discovery/27 §4) —
// this adapter federates both and dedupes when they represent the same
// underlying Shopify draft order.
//
// Matching preference order (docs/platform-discovery/29 §Fase 6 / ADR-007):
//   1. Shopify Customer GID (OfferteApp only — s4u-quote-app has no such
//      field, confirmed against its schema)
//   2. an existing, already-confirmed ExternalContactMatch
//   3. exact normalized email
//   4. exact normalized phone
//   5. otherwise unresolved (empty result, never a guess)
// Each tier is tried only if the previous one returned nothing — a stronger
// signal that finds zero quotes is trusted over falling through to a
// weaker one that might coincidentally match an unrelated customer.

const REQUEST_TIMEOUT_MS = 8_000;

export type QuoteActivityItem = {
  id: string;
  occurredAt: string;
  title: string;
  summary?: string;
  source: "offerteapp" | "s4u_quote_app";
};

export type QuoteSummary = {
  externalId: string;
  displayNumber: string;
  email: string | null;
  phone: string | null;
  shopifyCustomerGid: string | null;
  shopifyDraftOrderGid: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  total: string;
  currency: string;
  sourceSystem: "OFFERTEAPP" | "S4U_QUOTE_APP";
  adminUrl: string;
};

export type QuotesAdapterStatus = { available: true } | { available: false; reason: string };

export type QuoteMatchRefs = { customerProfileId?: string; shopifyCustomerGid?: string; email?: string; phone?: string };

export interface QuotesAdapter {
  status(): QuotesAdapterStatus;
  getActivityForCustomer(matchers: { email?: string; phone?: string }): Promise<QuoteActivityItem[]>;
  /** Full quote records for Customer 360's Commercieel tab — richer than
   * getActivityForCustomer's Timeline-projection shape. */
  getQuotesForCustomer(matchRefs: QuoteMatchRefs): Promise<QuoteSummary[]>;
}

export class DisabledQuotesAdapter implements QuotesAdapter {
  constructor(private reason: string = "Offerte-integratie is niet geconfigureerd.") {}

  status(): QuotesAdapterStatus {
    return { available: false, reason: this.reason };
  }

  async getActivityForCustomer(): Promise<QuoteActivityItem[]> {
    return [];
  }

  async getQuotesForCustomer(): Promise<QuoteSummary[]> {
    return [];
  }
}

type SiblingConfig = { baseUrl: string; serviceToken: string };

/** Extracts the bare numeric legacy resource ID from a Shopify GID
 * (`gid://shopify/Customer/123` → `123`) — OfferteApp stores that legacy
 * form, not the GID itself. */
function legacyIdFromGid(gid: string): string | null {
  const match = /\/(\d+)$/.exec(gid);
  return match?.[1] ?? null;
}

async function fetchJson<T>(url: URL, serviceToken: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${serviceToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error("quotes_adapter_http_error", url.hostname, response.status);
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    const label = error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed";
    console.error("quotes_adapter_" + label, url.hostname, error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchQuotes(
  config: SiblingConfig,
  params: { shopifyCustomerId?: string; email?: string; phone?: string },
): Promise<QuoteSummary[]> {
  const url = new URL("/api/integrations/control-center/quotes", config.baseUrl);
  if (params.shopifyCustomerId) url.searchParams.set("shopifyCustomerId", params.shopifyCustomerId);
  if (params.email) url.searchParams.set("email", params.email);
  if (params.phone) url.searchParams.set("phone", params.phone);

  const body = await fetchJson<{ quotes: QuoteSummary[] }>(url, config.serviceToken);
  return body?.quotes ?? [];
}

/** Two quotes represent the same commercial event when they reference the
 * identical Shopify draft order — the only reliable cross-system identity
 * these two uncoupled sources share (docs/platform-discovery/27 §4). Prefers
 * the OfferteApp record as canonical on a collision (the older, more
 * established internal system) — an arbitrary but documented tie-break. */
function dedupeByDraftOrder(quotes: QuoteSummary[]): QuoteSummary[] {
  const byDraftOrder = new Map<string, QuoteSummary>();
  const withoutDraftOrder: QuoteSummary[] = [];

  for (const quote of quotes) {
    if (!quote.shopifyDraftOrderGid) {
      withoutDraftOrder.push(quote);
      continue;
    }
    const existing = byDraftOrder.get(quote.shopifyDraftOrderGid);
    if (!existing || (existing.sourceSystem !== "OFFERTEAPP" && quote.sourceSystem === "OFFERTEAPP")) {
      byDraftOrder.set(quote.shopifyDraftOrderGid, quote);
    }
  }

  return [...byDraftOrder.values(), ...withoutDraftOrder];
}

export class FederatedQuotesAdapter implements QuotesAdapter {
  constructor(private offerteApp: SiblingConfig | null, private s4uQuoteApp: SiblingConfig | null) {}

  status(): QuotesAdapterStatus {
    return { available: true };
  }

  async getQuotesForCustomer(matchRefs: QuoteMatchRefs): Promise<QuoteSummary[]> {
    // Tier 1 — Shopify Customer GID (OfferteApp only).
    if (matchRefs.shopifyCustomerGid && this.offerteApp) {
      const legacyId = legacyIdFromGid(matchRefs.shopifyCustomerGid);
      if (legacyId) {
        const results = await fetchQuotes(this.offerteApp, { shopifyCustomerId: legacyId });
        if (results.length > 0) return dedupeByDraftOrder(results);
      }
    }

    // Tier 2 — an existing, already-confirmed ExternalContactMatch.
    if (matchRefs.customerProfileId) {
      const matches = await getMatchesForCustomer(matchRefs.customerProfileId);
      const quoteMatches = matches.filter((m) => m.source === "OFFERTEAPP" || m.source === "S4U_QUOTE_APP");
      if (quoteMatches.length > 0) {
        const results = await Promise.all(
          quoteMatches.map((m) => this.fetchSingleQuote(m.source === "OFFERTEAPP" ? "offerteapp" : "s4u_quote_app", m.externalRef)),
        );
        const found = results.filter((q): q is QuoteSummary => q !== null);
        if (found.length > 0) return dedupeByDraftOrder(found);
      }
    }

    // Tier 3 — exact normalized email.
    if (matchRefs.email) {
      const results = await this.fetchFromBoth({ email: matchRefs.email });
      if (results.length > 0) return dedupeByDraftOrder(results);
    }

    // Tier 4 — exact normalized phone.
    if (matchRefs.phone) {
      const results = await this.fetchFromBoth({ phone: matchRefs.phone });
      if (results.length > 0) return dedupeByDraftOrder(results);
    }

    // Tier 5 — unresolved.
    return [];
  }

  async getActivityForCustomer(matchers: { email?: string; phone?: string }): Promise<QuoteActivityItem[]> {
    const quotes = await this.getQuotesForCustomer(matchers);
    return quotes.map((quote) => ({
      id: `${quote.sourceSystem.toLowerCase()}-${quote.externalId}`,
      occurredAt: quote.createdAt,
      title: `Offerte ${quote.displayNumber}`,
      summary: `${quote.status} · €${quote.total}`,
      source: quote.sourceSystem === "OFFERTEAPP" ? "offerteapp" : "s4u_quote_app",
    }));
  }

  private async fetchFromBoth(params: { email?: string; phone?: string }): Promise<QuoteSummary[]> {
    const [offerteResults, s4uResults] = await Promise.all([
      this.offerteApp ? fetchQuotes(this.offerteApp, params) : Promise.resolve([]),
      this.s4uQuoteApp ? fetchQuotes(this.s4uQuoteApp, params) : Promise.resolve([]),
    ]);
    return [...offerteResults, ...s4uResults];
  }

  private async fetchSingleQuote(source: "offerteapp" | "s4u_quote_app", externalId: string): Promise<QuoteSummary | null> {
    const config = source === "offerteapp" ? this.offerteApp : this.s4uQuoteApp;
    if (!config) return null;
    const url = new URL(`/api/integrations/control-center/quotes/${encodeURIComponent(externalId)}`, config.baseUrl);
    return fetchJson<QuoteSummary>(url, config.serviceToken);
  }
}

export function createQuotesAdapter(): QuotesAdapter {
  const offerteAppBaseUrl = process.env.OFFERTEAPP_API_BASE_URL;
  const offerteAppToken = process.env.OFFERTEAPP_SERVICE_TOKEN;
  const s4uBaseUrl = process.env.S4U_QUOTE_APP_API_BASE_URL;
  const s4uToken = process.env.S4U_QUOTE_APP_SERVICE_TOKEN;

  const offerteApp = offerteAppBaseUrl && offerteAppToken ? { baseUrl: offerteAppBaseUrl, serviceToken: offerteAppToken } : null;
  const s4uQuoteApp = s4uBaseUrl && s4uToken ? { baseUrl: s4uBaseUrl, serviceToken: s4uToken } : null;

  if (!offerteApp && !s4uQuoteApp) {
    return new DisabledQuotesAdapter();
  }

  return new FederatedQuotesAdapter(offerteApp, s4uQuoteApp);
}

export type QuoteSearchResult = {
  customerProfileId: string;
  customerName: string;
  externalId: string;
  displayNumber: string;
  sourceSystem: "OFFERTEAPP" | "S4U_QUOTE_APP";
};

/** Command-palette quote-number search (docs/platform-discovery/29 §Fase 9).
 * A quote only becomes a navigable result once it resolves to an existing
 * CustomerProfile — never a live Shopify call to construct one on the fly
 * (mirrors src/integrations/shopify/order-search.ts's "no customer, nowhere
 * to navigate to" rule), and never a fuzzy name match (Fase 6: no fuzzy
 * match as a definitive link). No cross-app dedup here — a command-palette
 * result list benefits from showing "found in both systems" rather than
 * silently hiding one, unlike the Commercieel-tab list which does dedupe. */
export async function searchQuotesByNumber(term: string, limit = 8): Promise<QuoteSearchResult[]> {
  const offerteAppBaseUrl = process.env.OFFERTEAPP_API_BASE_URL;
  const offerteAppToken = process.env.OFFERTEAPP_SERVICE_TOKEN;
  const s4uBaseUrl = process.env.S4U_QUOTE_APP_API_BASE_URL;
  const s4uToken = process.env.S4U_QUOTE_APP_SERVICE_TOKEN;

  const configs: SiblingConfig[] = [
    ...(offerteAppBaseUrl && offerteAppToken ? [{ baseUrl: offerteAppBaseUrl, serviceToken: offerteAppToken }] : []),
    ...(s4uBaseUrl && s4uToken ? [{ baseUrl: s4uBaseUrl, serviceToken: s4uToken }] : []),
  ];
  if (configs.length === 0) return [];

  const results = await Promise.all(
    configs.map((config) => {
      const url = new URL("/api/integrations/control-center/quotes", config.baseUrl);
      url.searchParams.set("number", term);
      return fetchJson<{ quotes: QuoteSummary[] }>(url, config.serviceToken).then((body) => body?.quotes ?? []);
    }),
  );
  const quotes = results.flat();

  const resolved = await Promise.all(quotes.map((quote) => resolveQuoteToCustomer(quote)));
  return resolved.filter((r): r is QuoteSearchResult => r !== null).slice(0, limit);
}

async function resolveQuoteToCustomer(quote: QuoteSummary): Promise<QuoteSearchResult | null> {
  let profile = null;

  if (quote.shopifyCustomerGid) {
    profile = await prisma.customerProfile.findUnique({
      where: { shopifyCustomerGid: quote.shopifyCustomerGid },
      select: { id: true, displayName: true, companyName: true },
    });
  }

  if (!profile && quote.email) {
    const normalized = normalizeEmail(quote.email);
    if (normalized) {
      profile = await prisma.customerProfile.findFirst({
        where: { email: { equals: normalized, mode: "insensitive" } },
        select: { id: true, displayName: true, companyName: true },
      });
    }
  }

  if (!profile) return null;

  return {
    customerProfileId: profile.id,
    customerName: profile.displayName ?? profile.companyName ?? "Onbekende klant",
    externalId: quote.externalId,
    displayNumber: quote.displayNumber,
    sourceSystem: quote.sourceSystem,
  };
}

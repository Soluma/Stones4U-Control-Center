// Quotes adapter (OfferteApp + s4u-quote-app) — prepared interface only.
//
// STATUS: DISABLED IN PHASE 1. Neither OfferteApp (Flask) nor s4u-quote-app
// (Remix) exposes a read API suitable for external consumption today (see
// docs/platform-discovery/10 and 11) — unlike TelefoonSysteem, there isn't
// even a human-auth-gated endpoint to point at. Building one is Phase 7/8
// work (docs/platform-discovery/24) and requires a change in those
// repositories, which this build does not touch. This file exists purely so
// the Activity Timeline's adapter registry has a stable shape to extend
// later, matching the telephony/exact adapters' pattern.

export type QuoteActivityItem = {
  id: string;
  occurredAt: string;
  title: string;
  summary?: string;
  source: "offerteapp" | "s4u_quote_app";
};

export type QuotesAdapterStatus = { available: true } | { available: false; reason: string };

export interface QuotesAdapter {
  status(): QuotesAdapterStatus;
  getActivityForCustomer(matchers: { email?: string; phone?: string }): Promise<QuoteActivityItem[]>;
}

export class DisabledQuotesAdapter implements QuotesAdapter {
  status(): QuotesAdapterStatus {
    return {
      available: false,
      reason: "OfferteApp/s4u-quote-app hebben nog geen read-API; gepland voor Phase 7/8.",
    };
  }

  async getActivityForCustomer(): Promise<QuoteActivityItem[]> {
    return [];
  }
}

export function createQuotesAdapter(): QuotesAdapter {
  return new DisabledQuotesAdapter();
}

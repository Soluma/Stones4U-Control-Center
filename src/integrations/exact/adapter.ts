// Exact / customer-history adapter — read-only projection of invoice/
// revenue history into Customer 360 (docs/architecture/ADR-004).
//
// STATUS: DISABLED IN PHASE 1, for the same reason as
// src/integrations/telephony/adapter.ts: the only existing read path
// (TelefoonSysteem's GET /api/customer-history/*, itself a read-only proxy
// onto a separate Exact-sync database — see docs/platform-discovery/20) sits
// behind TelefoonSysteem's human-oriented JWT auth. No safe machine
// credential exists today, and TelefoonSysteem is not modified by this
// build. Interface only, wired to a disabled implementation.

export type InvoiceHistorySummary = {
  totalOutstanding: { amount: string; currencyCode: string } | null;
  lastInvoiceAt: string | null;
  recentInvoiceCount: number;
};

export type ExactAdapterStatus = { available: true } | { available: false; reason: string };

export interface ExactHistoryAdapter {
  status(): ExactAdapterStatus;
  /** Read-only. Must return null (never throw) when unavailable. */
  getSummaryForCustomer(matchers: { email?: string; phone?: string }): Promise<InvoiceHistorySummary | null>;
}

export class DisabledExactHistoryAdapter implements ExactHistoryAdapter {
  status(): ExactAdapterStatus {
    return {
      available: false,
      reason:
        "Exact-historie is alleen bereikbaar via TelefoonSysteem's proxy, die dezelfde ontbrekende machine-auth vereist; zie src/integrations/exact/adapter.ts.",
    };
  }

  async getSummaryForCustomer(): Promise<InvoiceHistorySummary | null> {
    return null;
  }
}

export function createExactHistoryAdapter(): ExactHistoryAdapter {
  return new DisabledExactHistoryAdapter();
}

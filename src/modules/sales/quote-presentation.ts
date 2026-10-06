// How quotes read on the Sales → Offertes overview. Presentation and pure
// filtering only — the source status is never changed or re-derived, only
// translated; an unknown status shows as the source wrote it.

export type QuoteSource = "OFFERTEAPP" | "S4U_QUOTE_APP";

export type QuoteRowInput = {
  sourceSystem: QuoteSource;
  status: string;
};

export const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: "Concept",
  new: "Nieuw",
  in_progress: "In behandeling",
  sent: "Verzonden",
  accepted: "Geaccepteerd",
  invoiced: "Gefactureerd",
  converted_to_order: "Order geworden",
  rejected: "Afgewezen",
  archived: "Gearchiveerd",
};

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "danger" | "accent"> = {
  draft: "neutral",
  new: "accent",
  in_progress: "warning",
  sent: "warning",
  accepted: "success",
  invoiced: "success",
  converted_to_order: "success",
  rejected: "danger",
  archived: "neutral",
};

export type QuoteSearchKind = "too_short" | "direct" | "name";

/**
 * How /quotes searches for a term.
 * - "direct": an e-mail address, a phone number, or an offertenummer/number
 *   ("2026", "OFF-2026-1006-006", "QR-20260930-00002", "0903-001") — sent to
 *   the quote sources as-is, like before.
 * - "name": anything else with letters ("verkoelen", "Jansen Tuinen BV",
 *   "stones4u") — no quote source can search on a name, so the customer is
 *   found in Shopify first and the quotes are fetched on its hard identifiers.
 *   Found in production (v32): a name sent as a number search returned an
 *   empty list that read like "this customer has no quotes".
 */
export function quoteSearchKind(term: string): QuoteSearchKind {
  const trimmed = term.trim();
  if (trimmed.length < 2) return "too_short";
  if (trimmed.includes("@")) return "direct";
  // A known quote/draft prefix may carry letters; what follows must be a number.
  const rest = trimmed.replace(/^(off|qr|q|d|#d|#)[-\s]?(?=\d)/i, "");
  if (/^\+?[\d\s\-/().]+$/.test(rest) && /\d/.test(rest)) return "direct";
  return "name";
}

export function quoteStatusLabel(status: string | null | undefined): string {
  const value = status?.trim() ?? "";
  if (!value) return "Geen status";
  return QUOTE_STATUS_LABELS[value] ?? value;
}

export function quoteStatusTone(status: string | null | undefined) {
  return STATUS_TONE[status?.trim() ?? ""] ?? "neutral";
}

export const QUOTE_SOURCE_LABELS: Record<QuoteSource, string> = {
  OFFERTEAPP: "OfferteApp",
  S4U_QUOTE_APP: "Webshop",
};

/** The external button text: where the click actually lands. */
export const QUOTE_ACTION_LABELS: Record<QuoteSource, string> = {
  OFFERTEAPP: "Openen in OfferteApp",
  S4U_QUOTE_APP: "Openen in Quote App",
};

/** URL value of the Bron filter → source system. */
export const QUOTE_SOURCE_FILTERS = {
  offerteapp: "OFFERTEAPP",
  webshop: "S4U_QUOTE_APP",
} as const satisfies Record<string, QuoteSource>;

export type QuoteSourceFilter = keyof typeof QUOTE_SOURCE_FILTERS | "all";

export function parseQuoteSourceFilter(value: string | null | undefined): QuoteSourceFilter {
  return value === "offerteapp" || value === "webshop" ? value : "all";
}

/** Filters the found set — never a new search. */
export function filterQuotes<T extends QuoteRowInput>(quotes: T[], filter: { source: QuoteSourceFilter; status: string }): T[] {
  return quotes.filter((quote) => {
    if (filter.source !== "all" && quote.sourceSystem !== QUOTE_SOURCE_FILTERS[filter.source]) return false;
    if (filter.status && quote.status !== filter.status) return false;
    return true;
  });
}

/** Counts over the found set only — never a claim about all quotes. */
export function quoteStats(quotes: QuoteRowInput[]): { new: number; inProgress: number; sent: number } {
  return {
    new: quotes.filter((q) => q.status === "new").length,
    inProgress: quotes.filter((q) => q.status === "in_progress").length,
    sent: quotes.filter((q) => q.status === "sent").length,
  };
}

/** The statuses present in the found set, for the Status filter. */
export function statusOptions(quotes: QuoteRowInput[]): { value: string; label: string }[] {
  return [...new Set(quotes.map((q) => q.status).filter(Boolean))]
    .sort((a, b) => quoteStatusLabel(a).localeCompare(quoteStatusLabel(b), "nl"))
    .map((value) => ({ value, label: quoteStatusLabel(value) }));
}

/** "#D570" when Shopify told us the name; "aanwezig" when only the GID is known. */
export function draftOrderDisplay(gid: string | null, names: Map<string, string>): string | null {
  if (!gid) return null;
  return names.get(gid) ?? "aanwezig";
}

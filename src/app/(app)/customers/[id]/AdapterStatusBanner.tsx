import { Info } from "lucide-react";
import { createTelephonyAdapter } from "@/integrations/telephony/adapter";
import { createQuotesAdapter } from "@/integrations/quotes/adapter";
import { createExactHistoryAdapter } from "@/integrations/exact/adapter";

// Surfaces adapter unavailability transparently rather than silently — see
// docs/platform-discovery/25 §8 ("Adapter-fout … niet-blokkerende
// melding"). Telephony/quotes are enabled once their sibling-side service
// auth + env vars are configured (Phase 3b) — until then, or if Exact stays
// unconfigured, this reads as an expected-state notice, not an error.
export function AdapterStatusBanner() {
  const telephony = createTelephonyAdapter().status();
  const quotes = createQuotesAdapter().status();
  const exact = createExactHistoryAdapter().status();

  if (telephony.available && quotes.available && exact.available) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-border-subtle bg-canvas px-3 py-2 text-xs text-ink-tertiary">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="space-y-0.5">
        {!telephony.available && <p>Gespreksgeschiedenis (TelefoonSysteem) is nog niet gekoppeld.</p>}
        {!quotes.available && <p>Offertes (OfferteApp/s4u-quote-app) zijn nog niet gekoppeld.</p>}
        {!exact.available && <p>Facturatiehistorie (Exact) is nog niet gekoppeld.</p>}
      </div>
    </div>
  );
}

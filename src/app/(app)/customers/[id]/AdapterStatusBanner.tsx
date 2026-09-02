import { createTelephonyAdapter } from "@/integrations/telephony/adapter";
import { createExactHistoryAdapter } from "@/integrations/exact/adapter";

// Surfaces adapter unavailability transparently rather than silently — see
// docs/platform-discovery/25 §8 ("Adapter-fout … niet-blokkerende
// melding"). In Phase 1 both adapters are disabled by design (no safe
// machine auth exists yet — src/integrations/telephony/adapter.ts and
// exact/adapter.ts), not merely down, so this reads as an expected-state
// notice rather than an error.
export function AdapterStatusBanner() {
  const telephony = createTelephonyAdapter().status();
  const exact = createExactHistoryAdapter().status();

  if (telephony.available && exact.available) return null;

  return (
    <div className="rounded-md border border-border-subtle bg-canvas px-3 py-2 text-xs text-ink-tertiary">
      {!telephony.available && <p>Gespreksgeschiedenis (TelefoonSysteem) is nog niet gekoppeld.</p>}
      {!exact.available && <p>Facturatiehistorie (Exact) is nog niet gekoppeld.</p>}
    </div>
  );
}

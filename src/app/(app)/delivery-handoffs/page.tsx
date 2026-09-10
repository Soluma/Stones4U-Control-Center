import { getSessionUser } from "@/platform/auth/session";
import { DeliveryHandoffsClient } from "./DeliveryHandoffsClient";

// Phase 5A — manual staff activation
// (docs/QUOTE-DELIVERY-DATE-MANUAL-ACTIVATION.md), extended in Phase 6E to
// cover real Shopify Orders (docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md
// §"Staff Order handoff management") as the safe manual fallback before
// automatic eligibility/mail is ever activated. No automatic handoff
// creation, no OfferteApp integration, no mail — a staff member finds a
// specific Order or Draft Order and deliberately creates a public
// delivery-date link for it.
export default async function DeliveryHandoffsPage() {
  const user = await getSessionUser();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Leverdatum-links</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Maak een publieke link waarmee een klant een gewenste leverdatum kan opgeven voor een bestelling of
          conceptbestelling. Dit is een wens van de klant, geen definitieve planning.
        </p>
      </div>
      <DeliveryHandoffsClient canCreate={user?.role !== "VIEWER"} />
    </div>
  );
}

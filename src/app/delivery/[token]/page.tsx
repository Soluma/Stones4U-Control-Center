import { notFound } from "next/navigation";
import { getEarliestRequestedDeliveryDate } from "@/modules/delivery/delivery-lead-time";
import { getHandoffByRawToken } from "@/modules/delivery/delivery-handoff.service";
import { resolveCustomerFacingModeForHandoff } from "@/modules/delivery/order-delivery-request.service";
import { DeliveryDateForm } from "./DeliveryDateForm";
import { OrderDeliveryDateForm } from "./OrderDeliveryDateForm";

// Public, unauthenticated route — no getSessionUser()/requireUser() call,
// same precedent as src/app/login (the only other public page in this
// app). Authorization is the opaque token itself, never a session.
//
// Phase 6D — this page now renders one of two fully separate experiences,
// chosen exclusively by the handoff's own persisted `commerceObjectType`
// (never a client-supplied value, a GID-string sniff, or a query param —
// see the POST route's own dispatch, which uses the same field the same
// way). SHOPIFY_DRAFT_ORDER keeps the original, unmodified
// checkout-oriented experience below byte-for-byte; SHOPIFY_ORDER renders
// a dedicated post-order experience via OrderDeliveryDateForm. A
// commerceObjectType this page doesn't explicitly recognize (none exists
// today) fails closed to the same generic 404 as an unresolved token,
// rather than guessing which experience to show.
//
// The Draft branch shows no order/draft reference (e.g. "#D684") — a
// historical Draft-based handoff never has a publicReference populated
// (Phase 6B added that field only for Order-based rows going forward, see
// schema.prisma), and this page still makes no Shopify call of its own.
// Never fabricate a reference; omit the context entirely when a
// trustworthy one isn't already available.

type PageProps = { params: Promise<{ token: string }> };

export default async function DeliveryDatePage({ params }: PageProps) {
  const { token } = await params;
  const handoff = await getHandoffByRawToken(token);

  // Generic 404 for any unresolved token — never distinguishes "malformed"
  // from "unknown, possibly valid-shaped" (avoids leaking which is which).
  if (!handoff) notFound();

  if (handoff.commerceObjectType === "SHOPIFY_ORDER") {
    // Phase 6AI — the fulfillment mode is re-resolved LIVE from the Shopify
    // Order, never taken from the browser and never trusted from the stored
    // snapshot. An Order can change between the request being sent and the
    // customer opening the link, and the page must reflect what is true now.
    //
    // A mode that is no longer customer-facing (NONE, RETAIL, PICKUP_POINT,
    // UNKNOWN), or an Order that has been cancelled, yields no usable form.
    const mode = await resolveCustomerFacingModeForHandoff(handoff);
    if (!mode) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
          <div className="w-full max-w-md text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">
              Dit verzoek is niet meer van toepassing
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-ink-tertiary">
              Voor deze bestelling hoeft geen datum meer te worden doorgegeven. Heeft u toch een vraag over uw
              bestelling? Neem dan gerust contact met ons op.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-md">
          <OrderDeliveryDateForm
            token={token}
            mode={mode}
            currentValue={handoff.requestedDeliveryDate ? handoff.requestedDeliveryDate.toISOString().slice(0, 10) : ""}
            publicReference={handoff.publicReference}
            // Phase 6R — the form is initialised from the persisted handoff,
            // which stays the single source of truth for what the customer
            // last told us. Nothing is read from the browser, and Shopify is
            // never consulted on GET (see §12: viewing must never reconcile).
            currentDeliveryComment={handoff.deliveryComment}
            currentLargeTruckAccessConfirmed={handoff.largeTruckAccessConfirmed}
            earliestDeliveryDate={getEarliestRequestedDeliveryDate({
              orderCreatedAt: handoff.createdAt,
              now: new Date(),
            })}
          />
        </div>
      </div>
    );
  }

  if (handoff.commerceObjectType !== "SHOPIFY_DRAFT_ORDER") {
    // Fail closed — see the module doc comment above.
    notFound();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">Bestelling afronden</p>
          <div className="mt-2 flex items-center justify-center gap-2 text-xs font-medium">
            <span className="text-accent-600">1. Gewenste leverdatum</span>
            <span className="text-ink-tertiary" aria-hidden="true">
              &rarr;
            </span>
            <span className="text-ink-tertiary">2. Factuur &amp; betaling</span>
          </div>

          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink-primary">
            Wanneer mogen we langskomen?
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-tertiary">
            Geef aan welke leverdatum u het beste uitkomt. We doen ons best om uw bestelling op deze datum te
            leveren.
          </p>
        </div>

        <div className="cc-card p-6 sm:p-8">
          <DeliveryDateForm
            token={token}
            currentValue={handoff.requestedDeliveryDate ? handoff.requestedDeliveryDate.toISOString().slice(0, 10) : ""}
            // Phase 6W §26 — computed from exactly the same inputs
            // submitRequestedDeliveryDate() validates with, so the picker can
            // never offer a date the POST handler will reject.
            earliestDeliveryDate={getEarliestRequestedDeliveryDate({
              orderCreatedAt: handoff.createdAt,
              now: new Date(),
            })}
          />
        </div>

        <div className="mt-6 space-y-2 text-center text-xs leading-relaxed text-ink-tertiary">
          <h2 className="font-medium text-ink-secondary">Wat gebeurt er daarna?</h2>
          <p>
            Na het kiezen van uw gewenste leverdatum gaat u verder naar uw factuur en betaling. Uw voorkeursdatum
            wordt bij uw bestelling opgeslagen en meegenomen in onze planning.
          </p>
          <p>De levering is pas definitief nadat deze door Stones4U is bevestigd.</p>
        </div>
      </div>
    </div>
  );
}

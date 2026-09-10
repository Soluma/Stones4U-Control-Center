import { notFound } from "next/navigation";
import { getHandoffByRawToken } from "@/modules/delivery/delivery-handoff.service";
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
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
        <div className="w-full max-w-md">
          <OrderDeliveryDateForm
            token={token}
            currentValue={handoff.requestedDeliveryDate ? handoff.requestedDeliveryDate.toISOString().slice(0, 10) : ""}
            publicReference={handoff.publicReference}
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

"use client";

import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { formatDateLong } from "@/lib/format";
import type { DeliveryDateSubmitResponse } from "@/modules/delivery/submit-response";

// Phase 6D — the post-order public experience for a SHOPIFY_ORDER handoff.
// Deliberately a separate component from DeliveryDateForm.tsx (the Draft
// flow), not a variant of it: this owns its own heading/intro/footer copy
// (not only the form), because a successful submission replaces that copy
// in place with a success state rather than redirecting — see the module
// doc comment on page.tsx for why the two flows are dispatched server-side
// and never share a code path. No billing-related copy anywhere in this
// file, in either state — an Order-based handoff is deliberately decoupled
// from payment status (docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"B2B
// boundary").

const DELIVERY_COMMENT_MAX_LENGTH = 500;

const LEAD_TIME_HINT =
  "Wij leveren van maandag t/m vrijdag. Tussen het doorgeven van uw voorkeur en de levering moeten minimaal twee volledige werkdagen zitten. Zaterdag en zondag tellen niet mee.";

// Phase 6AI — one form, two modes.
//
// A pickup order needs the same date question as a delivery, in different
// words and without the truck question (meaningless when the customer
// collects). Splitting this into two components would have duplicated the
// prefill, validation, submit and success handling — the parts most likely to
// drift apart — so the difference lives in copy, not in logic.
const MODE_COPY = {
  DELIVERY: {
    heading: "Wanneer mogen we langskomen?",
    intro:
      "Geef aan op welke datum u uw bestelling bij voorkeur wilt ontvangen. We doen ons best om hiermee rekening te houden.",
    dateLabel: "Gewenste bezorgdatum",
    dateHint:
      "De gekozen datum is een voorkeursdatum. De definitieve leverdatum wordt door Stones4U bevestigd.",
    commentLabel: "Opmerking voor de levering (optioneel)",
    commentPlaceholder:
      "Bijvoorbeeld: graag bellen bij aankomst, poort aan de zijkant of beperkte draairuimte.",
    submit: "Gegevens doorgeven",
    successLead: "Uw gewenste bezorgdatum is doorgegeven.",
    successFooter:
      "We nemen deze voorkeur mee in onze planning. De definitieve leverdatum wordt door Stones4U bevestigd.",
    next: "Wij nemen uw voorkeursdatum mee in onze planning. Zodra de levering definitief is ingepland, ontvangt u daarvan bericht.",
    showTruckQuestion: true,
  },
  CUSTOMER_PICKUP: {
    heading: "Wanneer wilt u uw bestelling ophalen?",
    intro:
      "Geef aan op welke dag u uw bestelling bij voorkeur komt ophalen, zodat wij alles voor u kunnen klaarzetten.",
    dateLabel: "Gewenste afhaaldatum",
    dateHint:
      "De gekozen datum is een voorkeursdatum. Stones4U bevestigt wanneer uw bestelling klaarstaat.",
    commentLabel: "Opmerking voor het afhalen (optioneel)",
    commentPlaceholder:
      "Bijvoorbeeld: ik kom met een aanhanger, of ik kom bij voorkeur in de ochtend.",
    submit: "Afhaalmoment doorgeven",
    successLead: "Uw gewenste afhaaldatum is doorgegeven.",
    successFooter: "We zetten uw bestelling klaar. Stones4U bevestigt wanneer u kunt komen.",
    next: "Wij zorgen dat uw bestelling op tijd klaarstaat. Zodra dat zo is, ontvangt u daarvan bericht.",
    showTruckQuestion: false,
  },
} as const;

export type OrderFormMode = keyof typeof MODE_COPY;

export function OrderDeliveryDateForm({
  token,
  mode,
  currentValue,
  publicReference,
  currentDeliveryComment,
  currentLargeTruckAccessConfirmed,
  earliestDeliveryDate,
}: {
  token: string;
  /** Resolved SERVER-SIDE from the live Shopify Order, never supplied by the
   * browser — see the page component. */
  mode: OrderFormMode;
  currentValue: string;
  publicReference: string | null;
  /** Phase 6R — what the customer last told us, so reopening the link shows
   * their own answers back rather than an empty form they could unknowingly
   * submit over. Plain text, rendered as-is. */
  currentDeliveryComment: string | null;
  /** `true` shows a ticked box. `false` and `null` both show an unticked box —
   * they are indistinguishable to the customer, and stay distinct in storage
   * only until this form is next submitted, at which point an unticked box
   * becomes a deliberate `false` because the question was actually asked. */
  currentLargeTruckAccessConfirmed: boolean | null;
  // Phase 6P — computed server-side in Europe/Amsterdam. Used as the picker's
  // `min`, which is a convenience only: the server re-validates every
  // submission against the same policy regardless of what the browser allows.
  earliestDeliveryDate: string;
}) {
  const copy = MODE_COPY[mode];
  const [date, setDate] = useState(currentValue);
  const [deliveryComment, setDeliveryComment] = useState(currentDeliveryComment ?? "");
  const [largeTruckAccessConfirmed, setLargeTruckAccessConfirmed] = useState(currentLargeTruckAccessConfirmed === true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [succeeded, setSucceeded] = useState<{
    requestedDeliveryDate: string;
    largeTruckAccessConfirmed: boolean | null;
  } | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const response = await fetch(`/api/delivery/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Phase 6AI — a pickup submission deliberately OMITS
      // largeTruckAccessConfirmed rather than sending false. The service's
      // PRESERVE/SET patch semantics then leave any stored value untouched:
      // a question that was never asked must not be answered on the
      // customer's behalf.
      body: JSON.stringify({
        requestedDeliveryDate: date,
        deliveryComment,
        ...(copy.showTruckQuestion ? { largeTruckAccessConfirmed } : {}),
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(body.error ?? "Er ging iets mis. Probeer het opnieuw.");
      setLoading(false);
      return;
    }

    // Server-authoritative outcome — never redirect, and never assume a
    // shape from field presence alone (build instruction §13). Anything
    // other than a trusted COMPLETED outcome is treated as an error rather
    // than guessed at.
    const result = body as DeliveryDateSubmitResponse;
    if (result.outcome !== "COMPLETED") {
      setError("Er ging iets mis. Probeer het opnieuw.");
      setLoading(false);
      return;
    }

    setSucceeded({
      requestedDeliveryDate: result.requestedDeliveryDate,
      largeTruckAccessConfirmed: result.largeTruckAccessConfirmed,
    });
    setLoading(false);
  }

  if (succeeded) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">Bedankt!</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-tertiary">{copy.successLead}</p>

        <div className="cc-card mt-6 p-6 sm:p-8">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{copy.dateLabel}</p>
          <p className="mt-1 text-lg font-semibold text-ink-primary">{formatDateLong(succeeded.requestedDeliveryDate)}</p>

          {copy.showTruckQuestion && (
            <>
              <p className="mt-4 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                Bereikbaarheid grote vrachtwagen
              </p>
              <p className="mt-1 text-sm text-ink-secondary">
                {succeeded.largeTruckAccessConfirmed ? "Bevestigd" : "Niet bevestigd"}
              </p>
            </>
          )}
        </div>

        <div className="mt-6 space-y-2 text-xs leading-relaxed text-ink-tertiary">
          <p>{copy.successFooter}</p>
          <p>U kunt deze pagina nu sluiten.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-8 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">Bestelling geplaatst</p>
        {publicReference && <p className="mt-1 text-xs font-medium text-ink-tertiary">Bestelling {publicReference}</p>}

        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink-primary">{copy.heading}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-tertiary">Bedankt voor uw bestelling bij Stones4U.</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-tertiary">{copy.intro}</p>
      </div>

      <div className="cc-card p-6 sm:p-8">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label={copy.dateLabel}
            id="requestedDeliveryDate"
            type="date"
            required
            min={earliestDeliveryDate}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            hint={copy.dateHint}
            error={error ?? undefined}
          />

          <p className="text-xs leading-relaxed text-ink-tertiary">{LEAD_TIME_HINT}</p>

          {/* Phase 6AI — a pickup customer is never asked about truck access.
              The field is not merely hidden: nothing is SENT for it either, so
              the stored value stays untouched rather than being overwritten
              with a fabricated `false`. See the submit handler. */}
          {copy.showTruckQuestion && (
            <label className="flex items-start gap-3 text-sm text-ink-secondary">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-accent-600"
                checked={largeTruckAccessConfirmed}
                onChange={(e) => setLargeTruckAccessConfirmed(e.target.checked)}
              />
              <span>
                Ja, de afleverlocatie is bereikbaar met een grote vrachtwagen.
                <span className="mt-1 block text-xs leading-relaxed text-ink-tertiary">
                  Denk aan voldoende ruimte om de locatie te bereiken, te manoeuvreren en te lossen.
                </span>
              </span>
            </label>
          )}

          <div className="space-y-1">
            <label htmlFor="deliveryComment" className="block text-sm font-medium text-ink-secondary">
              {copy.commentLabel}
            </label>
            <textarea
              id="deliveryComment"
              rows={3}
              maxLength={DELIVERY_COMMENT_MAX_LENGTH}
              value={deliveryComment}
              onChange={(e) => setDeliveryComment(e.target.value)}
              placeholder={copy.commentPlaceholder}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
            />
          </div>

          <Button type="submit" variant="primary" className="w-full" loading={loading}>
            {copy.submit}
          </Button>
        </form>
      </div>

      <div className="mt-6 space-y-2 text-center text-xs leading-relaxed text-ink-tertiary">
        <h2 className="font-medium text-ink-secondary">Wat gebeurt er daarna?</h2>
        <p>{copy.next}</p>
      </div>
    </>
  );
}

"use client";

import { Input } from "@/components/ui/Input";

// Phase 6T — the three questions every customer is asked, wherever they were
// asked from.
//
// Phase 6P/6R built these into the Order form only, so the Draft flow kept
// showing a date-only page with a client-side `today` minimum — offering
// dates the server had already started rejecting. Sharing one component is
// what stops the two flows drifting apart again: the date rules, the truck
// question and the remark now have exactly one definition, and only the
// post-submit behaviour (payment redirect vs. success screen) stays specific
// to the commerce object.

export const DELIVERY_COMMENT_MAX_LENGTH = 500;

export const LEAD_TIME_HINT =
  "Wij leveren van maandag t/m vrijdag. Tussen het doorgeven van uw voorkeur en de levering moeten minimaal twee volledige werkdagen zitten. Zaterdag en zondag tellen niet mee.";

export function DeliveryLogisticsFields({
  date,
  onDateChange,
  /** Server-computed in Europe/Amsterdam. A convenience for the picker only —
   * the server revalidates every submission against the same policy, so a
   * stale prefilled date is caught even though it stays visible. */
  earliestDeliveryDate,
  largeTruckAccessConfirmed,
  onLargeTruckAccessChange,
  deliveryComment,
  onDeliveryCommentChange,
  error,
  disabled,
}: {
  date: string;
  onDateChange: (value: string) => void;
  earliestDeliveryDate: string;
  largeTruckAccessConfirmed: boolean;
  onLargeTruckAccessChange: (value: boolean) => void;
  deliveryComment: string;
  onDeliveryCommentChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <>
      <Input
        label="Gewenste leverdatum"
        id="requestedDeliveryDate"
        type="date"
        required
        min={earliestDeliveryDate}
        value={date}
        onChange={(e) => onDateChange(e.target.value)}
        hint="De gekozen datum is een voorkeursdatum. De definitieve leverdatum wordt door Stones4U bevestigd."
        error={error}
      />

      <p className="text-xs leading-relaxed text-ink-tertiary">{LEAD_TIME_HINT}</p>

      <label className="flex items-start gap-3 text-sm text-ink-secondary">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-accent-600"
          checked={largeTruckAccessConfirmed}
          disabled={disabled}
          onChange={(e) => onLargeTruckAccessChange(e.target.checked)}
        />
        <span>
          Ja, de afleverlocatie is bereikbaar met een grote vrachtwagen.
          <span className="mt-1 block text-xs leading-relaxed text-ink-tertiary">
            Denk aan voldoende ruimte om de locatie te bereiken, te manoeuvreren en te lossen.
          </span>
        </span>
      </label>

      <div className="space-y-1">
        <label htmlFor="deliveryComment" className="block text-sm font-medium text-ink-secondary">
          Opmerking voor de levering (optioneel)
        </label>
        <textarea
          id="deliveryComment"
          rows={3}
          maxLength={DELIVERY_COMMENT_MAX_LENGTH}
          value={deliveryComment}
          disabled={disabled}
          onChange={(e) => onDeliveryCommentChange(e.target.value)}
          placeholder="Bijvoorbeeld: graag bellen bij aankomst, poort aan de zijkant of beperkte draairuimte."
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
      </div>
    </>
  );
}

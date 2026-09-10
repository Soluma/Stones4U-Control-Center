"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { DeliveryLogisticsFields } from "./DeliveryLogisticsFields";

// The Draft Order flow. Phase 6T brought it onto the same questions and the
// same date policy as the Order flow by sharing DeliveryLogisticsFields —
// before that it asked only for a date, with a client-side `today` minimum
// that offered dates the server already rejected.
//
// What stays specific to this flow is only what happens *after* a successful
// submission: a Draft handoff continues on to the existing invoice/payment
// destination, resolved server-side and returned as `redirectUrl`. That
// contract is untouched.

export function DeliveryDateForm({
  token,
  currentValue,
  currentDeliveryComment,
  currentLargeTruckAccessConfirmed,
  earliestDeliveryDate,
}: {
  token: string;
  currentValue: string;
  /** Prefilled from the persisted handoff, so reopening the link shows the
   * customer their own answers instead of a blank form they could
   * unknowingly submit over. */
  currentDeliveryComment: string | null;
  currentLargeTruckAccessConfirmed: boolean | null;
  earliestDeliveryDate: string;
}) {
  const [date, setDate] = useState(currentValue);
  const [deliveryComment, setDeliveryComment] = useState(currentDeliveryComment ?? "");
  const [largeTruckAccessConfirmed, setLargeTruckAccessConfirmed] = useState(
    currentLargeTruckAccessConfirmed === true,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const response = await fetch(`/api/delivery/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestedDeliveryDate: date,
        deliveryComment,
        largeTruckAccessConfirmed,
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(body.error ?? "Er ging iets mis. Probeer het opnieuw.");
      setLoading(false);
      return;
    }

    // Server-authoritative redirect target — body.redirectUrl is the only
    // value ever navigated to, never anything client-constructed. Unchanged
    // by Phase 6T.
    window.location.href = body.redirectUrl;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DeliveryLogisticsFields
        date={date}
        onDateChange={setDate}
        earliestDeliveryDate={earliestDeliveryDate}
        largeTruckAccessConfirmed={largeTruckAccessConfirmed}
        onLargeTruckAccessChange={setLargeTruckAccessConfirmed}
        deliveryComment={deliveryComment}
        onDeliveryCommentChange={setDeliveryComment}
        error={error ?? undefined}
        disabled={loading}
      />
      <Button type="submit" variant="primary" className="w-full" loading={loading}>
        Leverdatum opslaan en verder naar factuur
      </Button>
    </form>
  );
}

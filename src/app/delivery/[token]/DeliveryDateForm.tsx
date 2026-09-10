"use client";

import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

// Phase 6W (build instruction §26) — the date minimum now comes from the
// server, not from the browser's clock.
//
// Before this, `min` was `new Date()` in the visitor's own timezone: the
// picker happily offered dates the server then rejected, which is exactly
// what Fons saw in production (a prefilled 11-09-2026 while the earliest
// valid date was 15-09-2026). The server has always been authoritative — it
// validates every submission through validateRequestedDeliveryDate() — so
// this only stops the form from *offering* what the server will refuse.
//
// `earliestDeliveryDate` must be computed with getEarliestRequestedDeliveryDate()
// from the SAME inputs the POST handler validates with (the handoff's own
// createdAt and now), or the picker and the validator can disagree again.
//
// This is the only change to the legacy Draft form: no truck-access
// question, no delivery comment, and the payment redirect is untouched.
export function DeliveryDateForm({
  token,
  currentValue,
  earliestDeliveryDate,
}: {
  token: string;
  currentValue: string;
  earliestDeliveryDate: string;
}) {
  const [date, setDate] = useState(currentValue);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const response = await fetch(`/api/delivery/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedDeliveryDate: date }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(body.error ?? "Er ging iets mis. Probeer het opnieuw.");
      setLoading(false);
      return;
    }

    // Server-authoritative redirect target — body.redirectUrl is the only
    // value ever navigated to, never anything client-constructed.
    window.location.href = body.redirectUrl;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Gewenste leverdatum"
        id="requestedDeliveryDate"
        type="date"
        required
        min={earliestDeliveryDate}
        value={date}
        onChange={(e) => setDate(e.target.value)}
        hint="De gekozen datum is een voorkeursdatum. De definitieve leverdatum wordt door Stones4U bevestigd."
        error={error ?? undefined}
      />
      <Button type="submit" variant="primary" className="w-full" loading={loading}>
        Leverdatum opslaan en verder naar factuur
      </Button>
    </form>
  );
}

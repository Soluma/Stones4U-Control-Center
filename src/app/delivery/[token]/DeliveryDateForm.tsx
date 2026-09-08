"use client";

import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function DeliveryDateForm({ token, currentValue }: { token: string; currentValue: string }) {
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
        min={todayIsoDate()}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      {error && <p className="text-sm text-danger-500">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" loading={loading}>
        Verder naar betaling
      </Button>
    </form>
  );
}

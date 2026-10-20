"use client";

import { useEffect, useState } from "react";

// Op rekening v1 — shows (and, for an ADMIN, edits) the customer's
// on-account permission and payment term. Read live from Shopify
// (stones4u.credit_allowed / stones4u.payment_term_days); never stored in
// the CRM database (ADR-002).

type CreditView = {
  creditAllowed: boolean;
  effectiveTermDays: number | null;
  storedTermDays: number | null;
  invalidStoredValue: string | null;
};

export function CustomerCreditControl({ customerProfileId, canEdit }: { customerProfileId: string; canEdit: boolean }) {
  const [view, setView] = useState<CreditView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [days, setDays] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/customers/${customerProfileId}/credit`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok) setError(data?.error ?? "Kon betaalvoorwaarden niet ophalen.");
        else setView(data);
      })
      .catch(() => !cancelled && setError("Kon betaalvoorwaarden niet ophalen."));
    return () => {
      cancelled = true;
    };
  }, [customerProfileId]);

  function startEdit() {
    if (!view) return;
    setAllowed(view.creditAllowed);
    setDays(view.storedTermDays ? String(view.storedTermDays) : "");
    setEditing(true);
  }

  async function save() {
    const trimmed = days.trim();
    const termDays = trimmed === "" ? null : Number(trimmed);
    if (termDays !== null && (!Number.isInteger(termDays) || termDays < 1 || termDays > 365)) {
      setError("Betaaltermijn: een geheel aantal dagen (1–365), of leeg voor 30.");
      return;
    }
    const summary = allowed ? `op rekening, ${termDays ?? 30} dagen na levering` : "niet op rekening";
    if (!window.confirm(`Betaalvoorwaarden van deze klant wijzigen naar: ${summary}?\n\nGeldt voor nieuwe orders; bestaande orders houden hun termijn.`)) return;
    setSaving(true);
    setError(null);
    const r = await fetch(`/api/customers/${customerProfileId}/credit`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creditAllowed: allowed, termDays }),
    });
    const data = await r.json().catch(() => null);
    setSaving(false);
    if (!r.ok) {
      setError(data?.error ?? "Opslaan mislukt.");
      return;
    }
    setView(data);
    setEditing(false);
  }

  if (error && !view) return <span className="text-xs text-danger-700">{error}</span>;
  if (!view) return <span className="text-xs text-ink-tertiary">laden…</span>;

  const label = view.invalidStoredValue
    ? `ongeldige termijn "${view.invalidStoredValue}" — controleer`
    : view.creditAllowed
      ? `ja, ${view.effectiveTermDays} dagen na levering${view.storedTermDays ? "" : " (standaard)"}`
      : "nee";

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={`font-medium ${view.creditAllowed ? "text-ink-secondary" : "text-ink-tertiary"}`}>{label}</span>
        {canEdit && (
          <button type="button" onClick={startEdit} className="text-xs text-accent-700 underline-offset-2 hover:underline cc-focus-ring">
            wijzigen
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-1">
        <input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} disabled={saving} />
        <span>mag op rekening</span>
      </label>
      <label className="inline-flex items-center gap-1">
        <input
          type="number"
          min={1}
          max={365}
          inputMode="numeric"
          value={days}
          placeholder="30"
          onChange={(e) => setDays(e.target.value)}
          disabled={saving || !allowed}
          className="w-16 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs cc-focus-ring"
        />
        <span>dagen na levering</span>
      </label>
      <button type="button" onClick={save} disabled={saving} className="rounded-md border border-border px-2 py-0.5 text-xs font-medium cc-focus-ring disabled:opacity-60">
        {saving ? "Opslaan…" : "Opslaan"}
      </button>
      <button type="button" onClick={() => setEditing(false)} disabled={saving} className="text-xs text-ink-tertiary cc-focus-ring">
        annuleren
      </button>
      {error && <span className="text-xs text-danger-700">{error}</span>}
    </span>
  );
}

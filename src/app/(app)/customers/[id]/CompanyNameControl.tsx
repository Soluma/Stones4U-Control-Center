"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";

// Phase 5a — docs/architecture/ADR-011-CUSTOMER-IDENTITY-TYPE.md §2, build
// spec §14. companyNameConfirmed distinguishes "still following Shopify"
// (grey, auto-refreshing) from "manually confirmed/corrected" (accent,
// protected from the next Shopify sync) — the "Gebruik weer Shopify" reset
// action is only meaningful, and only shown, in the confirmed state.
export function CompanyNameControl({
  customerProfileId,
  companyName,
  companyNameConfirmed,
  canEdit,
}: {
  customerProfileId: string;
  companyName: string | null;
  companyNameConfirmed: boolean;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(companyName ?? "");
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function handleSave() {
    setSaving(true);
    await fetch(`/api/customers/${customerProfileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: value.trim() || null }),
    });
    setSaving(false);
    setEditing(false);
    router.refresh();
  }

  async function handleReset() {
    setSaving(true);
    await fetch(`/api/customers/${customerProfileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resetCompanyNameToShopify: true }),
    });
    setSaving(false);
    router.refresh();
  }

  if (!canEdit) {
    return <span>{companyName ?? "—"}</span>;
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <input
          autoFocus
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="Geen bedrijf"
          className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs cc-focus-ring disabled:opacity-60"
        />
        <button type="button" onClick={handleSave} disabled={saving} className="text-xs font-medium text-accent-700">
          Opslaan
        </button>
        <button type="button" onClick={() => setEditing(false)} disabled={saving} className="text-xs text-ink-tertiary">
          Annuleren
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={companyNameConfirmed ? "Handmatig bevestigd" : "Automatisch van Shopify"}
        className="text-xs font-medium text-ink-secondary underline decoration-dotted underline-offset-2 hover:text-ink-primary"
      >
        {companyName ?? "Geen bedrijf toevoegen"}
      </button>
      {companyNameConfirmed && (
        <button
          type="button"
          onClick={handleReset}
          disabled={saving}
          title="Gebruik weer Shopify"
          className="inline-flex items-center gap-1 text-xs text-ink-tertiary hover:text-ink-secondary disabled:opacity-60"
        >
          <RotateCcw className="h-3 w-3" aria-hidden />
          Gebruik weer Shopify
        </button>
      )}
    </span>
  );
}

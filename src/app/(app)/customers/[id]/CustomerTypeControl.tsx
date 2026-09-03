"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Phase 5a — docs/architecture/ADR-011-CUSTOMER-IDENTITY-TYPE.md. Mirrors
// CrmStatusControl.tsx/AccountManagerControl.tsx. The empty-string option
// maps to customerTypeOverride=null ("Automatisch" — derive from
// companyName, see effectiveCustomerType()), not to INDIVIDUAL.
const TYPE_OPTIONS = [
  { value: "", label: "Automatisch" },
  { value: "INDIVIDUAL", label: "Particulier" },
  { value: "ORGANIZATION", label: "Zakelijk" },
] as const;

export function CustomerTypeControl({
  customerProfileId,
  override,
  canEdit,
}: {
  customerProfileId: string;
  override: "INDIVIDUAL" | "ORGANIZATION" | null;
  canEdit: boolean;
}) {
  const [value, setValue] = useState(override ?? "");
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const current = TYPE_OPTIONS.find((o) => o.value === value);

  async function handleChange(next: string) {
    setValue(next);
    setSaving(true);
    await fetch(`/api/customers/${customerProfileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerTypeOverride: next || null }),
    });
    setSaving(false);
    router.refresh();
  }

  if (!canEdit) {
    return <span className="font-medium text-ink-secondary">{current?.label ?? value}</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value}
        disabled={saving}
        onChange={(e) => handleChange(e.target.value)}
        className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-secondary cc-focus-ring disabled:opacity-60"
      >
        {TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {value === "" && <span className="text-xs text-ink-tertiary">bepaald op basis van bedrijfsnaam</span>}
    </div>
  );
}

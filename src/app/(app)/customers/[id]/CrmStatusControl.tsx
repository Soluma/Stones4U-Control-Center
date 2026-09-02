"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const STATUS_OPTIONS = [
  { value: "LEAD", label: "Lead" },
  { value: "ACTIVE", label: "Actief" },
  { value: "INACTIVE", label: "Inactief" },
  { value: "AT_RISK", label: "Risico" },
  { value: "VIP", label: "VIP" },
] as const;

export function CrmStatusControl({
  customerProfileId,
  status,
  canEdit,
}: {
  customerProfileId: string;
  status: string;
  canEdit: boolean;
}) {
  const [value, setValue] = useState(status);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function handleChange(next: string) {
    setValue(next);
    setSaving(true);
    await fetch(`/api/customers/${customerProfileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crmStatus: next }),
    });
    setSaving(false);
    router.refresh();
  }

  if (!canEdit) {
    return (
      <span className="rounded-md border border-border px-2 py-1 text-xs font-medium text-ink-secondary">
        {STATUS_OPTIONS.find((o) => o.value === value)?.label ?? value}
      </span>
    );
  }

  return (
    <select
      value={value}
      disabled={saving}
      onChange={(e) => handleChange(e.target.value)}
      className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-ink-primary focus:outline-none focus:ring-2 focus:ring-accent-400"
    >
      {STATUS_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

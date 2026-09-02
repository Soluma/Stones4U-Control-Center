"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

const STATUS_OPTIONS = [
  { value: "LEAD", label: "Lead", tone: "border-border text-ink-secondary" },
  { value: "ACTIVE", label: "Actief", tone: "border-success-500/30 text-success-700" },
  { value: "INACTIVE", label: "Inactief", tone: "border-border text-ink-tertiary" },
  { value: "AT_RISK", label: "Risico", tone: "border-warning-500/30 text-warning-700" },
  { value: "VIP", label: "VIP", tone: "border-accent-500/30 text-accent-700" },
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
  const current = STATUS_OPTIONS.find((o) => o.value === value);

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
      <span className={cn("rounded-md border bg-surface px-2 py-0.5 text-xs font-medium", current?.tone)}>
        {current?.label ?? value}
      </span>
    );
  }

  return (
    <select
      value={value}
      disabled={saving}
      onChange={(e) => handleChange(e.target.value)}
      className={cn(
        "rounded-md border bg-surface px-2 py-0.5 text-xs font-medium cc-focus-ring disabled:opacity-60",
        current?.tone,
      )}
    >
      {STATUS_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

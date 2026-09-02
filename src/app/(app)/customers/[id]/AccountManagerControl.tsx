"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AccountManagerControl({
  customerProfileId,
  currentManagerId,
  managers,
  canEdit,
}: {
  customerProfileId: string;
  currentManagerId: string | null;
  managers: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const [value, setValue] = useState(currentManagerId ?? "");
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function handleChange(next: string) {
    setValue(next);
    setSaving(true);
    await fetch(`/api/customers/${customerProfileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountManagerId: next || null }),
    });
    setSaving(false);
    router.refresh();
  }

  if (!canEdit) {
    return <span className="font-medium text-ink-secondary">{managers.find((m) => m.id === currentManagerId)?.name ?? "Niet toegewezen"}</span>;
  }

  return (
    <select
      value={value}
      disabled={saving}
      onChange={(e) => handleChange(e.target.value)}
      className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs font-medium text-ink-secondary cc-focus-ring disabled:opacity-60"
    >
      <option value="">Niet toegewezen</option>
      {managers.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}

"use client";

import { useState, type FormEvent } from "react";

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [status, setStatus] = useState<{ type: "error" | "success"; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setStatus(null);

    const response = await fetch("/api/settings/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setStatus({ type: "error", message: body.error ?? "Wijzigen mislukt." });
    } else {
      setStatus({ type: "success", message: "Wachtwoord gewijzigd." });
      setCurrentPassword("");
      setNewPassword("");
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="cc-card max-w-sm space-y-3 p-5">
      <div>
        <label className="cc-label">Huidig wachtwoord</label>
        <input type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="cc-input" />
      </div>
      <div>
        <label className="cc-label">Nieuw wachtwoord</label>
        <input type="password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="cc-input" />
      </div>
      {status && (
        <p className={`rounded-md px-3 py-2 text-sm ${status.type === "error" ? "bg-danger-50 text-danger-700" : "bg-success-50 text-success-700"}`}>
          {status.message}
        </p>
      )}
      <button type="submit" disabled={submitting} className="cc-btn-primary">
        {submitting ? "Bezig…" : "Wachtwoord wijzigen"}
      </button>
    </form>
  );
}

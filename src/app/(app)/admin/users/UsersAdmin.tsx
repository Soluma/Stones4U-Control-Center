"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/format";

type Role = "ADMIN" | "AGENT" | "VIEWER";
type User = { id: string; email: string; name: string; role: Role; active: boolean; lastLoginAt: string | null; createdAt: string };

export function UsersAdmin({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "AGENT" as Role });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    const response = await fetch("/api/admin/users");
    const data = await response.json();
    setUsers(data.users ?? []);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate() {
    setSubmitting(true);
    setError(null);
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Aanmaken mislukt.");
      setSubmitting(false);
      return;
    }
    setForm({ email: "", name: "", password: "", role: "AGENT" });
    setShowForm(false);
    setSubmitting(false);
    await refresh();
  }

  async function handleRoleChange(userId: string, role: Role) {
    await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    await refresh();
  }

  async function handleDeactivate(userId: string) {
    if (!confirm("Deze gebruiker deactiveren? Alle actieve sessies worden direct beëindigd.")) return;
    await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    await refresh();
  }

  return (
    <div className="space-y-4">
      {!showForm ? (
        <button onClick={() => setShowForm(true)} className="cc-btn-primary">
          + Gebruiker toevoegen
        </button>
      ) : (
        <div className="cc-card space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input placeholder="Naam" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="cc-input" />
            <input
              placeholder="E-mailadres"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="cc-input"
            />
            <input
              placeholder="Tijdelijk wachtwoord (min. 10 tekens)"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="cc-input"
            />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} className="cc-input">
              <option value="ADMIN">Beheerder</option>
              <option value="AGENT">Medewerker</option>
              <option value="VIEWER">Alleen-lezen</option>
            </select>
          </div>
          {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="cc-btn-secondary">
              Annuleren
            </button>
            <button onClick={handleCreate} disabled={submitting} className="cc-btn-primary">
              {submitting ? "Aanmaken…" : "Gebruiker aanmaken"}
            </button>
          </div>
        </div>
      )}

      <div className="cc-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs text-ink-tertiary">
              <th className="px-4 py-2.5 font-medium">Naam</th>
              <th className="px-4 py-2.5 font-medium">E-mail</th>
              <th className="px-4 py-2.5 font-medium">Rol</th>
              <th className="px-4 py-2.5 font-medium">Laatst ingelogd</th>
              <th className="px-4 py-2.5 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {users?.map((u) => (
              <tr key={u.id} className={!u.active ? "opacity-50" : undefined}>
                <td className="px-4 py-2.5 font-medium text-ink-primary">{u.name}</td>
                <td className="px-4 py-2.5 text-ink-secondary">{u.email}</td>
                <td className="px-4 py-2.5">
                  <select
                    value={u.role}
                    disabled={u.id === currentUserId}
                    onChange={(e) => handleRoleChange(u.id, e.target.value as Role)}
                    className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
                  >
                    <option value="ADMIN">Beheerder</option>
                    <option value="AGENT">Medewerker</option>
                    <option value="VIEWER">Alleen-lezen</option>
                  </select>
                </td>
                <td className="px-4 py-2.5 text-ink-secondary">{formatDate(u.lastLoginAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  {u.active ? (
                    u.id !== currentUserId && (
                      <button onClick={() => handleDeactivate(u.id)} className="cc-btn-ghost text-xs text-danger-500">
                        Deactiveren
                      </button>
                    )
                  ) : (
                    <Badge tone="neutral">Gedeactiveerd</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { formatDate } from "@/lib/format";

type Role = "ADMIN" | "AGENT" | "VIEWER";
type User = { id: string; email: string; name: string; role: Role; active: boolean; lastLoginAt: string | null; createdAt: string };

const ROLE_LABEL: Record<Role, string> = { ADMIN: "Beheerder", AGENT: "Medewerker", VIEWER: "Alleen-lezen" };

export function UsersAdmin({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
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
    setDialogOpen(false);
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
      <Button variant="primary" icon={<UserPlus className="h-3.5 w-3.5" />} onClick={() => setDialogOpen(true)}>
        Gebruiker toevoegen
      </Button>

      <Table>
        <TableHead>
          <TableHeaderCell>Naam</TableHeaderCell>
          <TableHeaderCell>E-mail</TableHeaderCell>
          <TableHeaderCell>Rol</TableHeaderCell>
          <TableHeaderCell>Laatst ingelogd</TableHeaderCell>
          <TableHeaderCell className="text-right">Status</TableHeaderCell>
        </TableHead>
        <TableBody>
          {users?.map((u) => (
            <TableRow key={u.id} className={!u.active ? "opacity-50" : undefined}>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <Avatar name={u.name} size="sm" />
                  <span className="font-medium text-ink-primary">{u.name}</span>
                </div>
              </TableCell>
              <TableCell className="text-ink-secondary">{u.email}</TableCell>
              <TableCell>
                <select
                  value={u.role}
                  disabled={u.id === currentUserId}
                  onChange={(e) => handleRoleChange(u.id, e.target.value as Role)}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-xs disabled:opacity-50"
                >
                  <option value="ADMIN">Beheerder</option>
                  <option value="AGENT">Medewerker</option>
                  <option value="VIEWER">Alleen-lezen</option>
                </select>
              </TableCell>
              <TableCell className="text-ink-secondary">{formatDate(u.lastLoginAt)}</TableCell>
              <TableCell className="text-right">
                {u.active ? (
                  u.id !== currentUserId && (
                    <Button variant="ghost" size="sm" onClick={() => handleDeactivate(u.id)} className="!text-danger-500">
                      Deactiveren
                    </Button>
                  )
                ) : (
                  <Badge tone="neutral">Gedeactiveerd</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Gebruiker toevoegen"
        description={`Rol: ${ROLE_LABEL[form.role]}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={submitting} onClick={handleCreate}>
              Gebruiker aanmaken
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input label="Naam" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          <Input label="E-mailadres" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input
            label="Tijdelijk wachtwoord"
            hint="Minimaal 10 tekens"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Select label="Rol" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            <option value="ADMIN">Beheerder</option>
            <option value="AGENT">Medewerker</option>
            <option value="VIEWER">Alleen-lezen</option>
          </Select>
          {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
        </div>
      </Dialog>
    </div>
  );
}

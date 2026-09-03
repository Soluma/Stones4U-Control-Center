"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { formatDateTime } from "@/lib/format";

type Appointment = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  assignedTo: { id: string; name: string };
};

type AssignableUser = { id: string; name: string };

const STATUS_TONE: Record<Appointment["status"], "neutral" | "success" | "danger"> = {
  SCHEDULED: "neutral",
  COMPLETED: "success",
  CANCELLED: "danger",
};

const STATUS_LABEL: Record<Appointment["status"], string> = {
  SCHEDULED: "Gepland",
  COMPLETED: "Voltooid",
  CANCELLED: "Geannuleerd",
};

export function AppointmentsPanel({
  customerId,
  opportunityId,
  canEdit,
}: {
  customerId?: string;
  opportunityId?: string;
  canEdit: boolean;
}) {
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Phase 4a — opportunity-scoped when opportunityId is given.
  const basePath = opportunityId ? `/api/opportunities/${opportunityId}` : `/api/customers/${customerId}`;

  const refresh = useCallback(async () => {
    const response = await fetch(`${basePath}/appointments`);
    const data = await response.json();
    setAppointments(data.appointments ?? []);
  }, [basePath]);

  useEffect(() => {
    void refresh();
    fetch("/api/users/assignable")
      .then((r) => r.json())
      .then((data) => setUsers(data.users ?? []));
  }, [refresh]);

  async function handleCreate() {
    if (title.trim().length === 0 || !assignedToId || !startsAt) return;
    setSubmitting(true);
    await fetch(`${basePath}/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: description || undefined,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
        assignedToId,
      }),
    });
    setTitle("");
    setDescription("");
    setStartsAt("");
    setEndsAt("");
    setAssignedToId("");
    setDialogOpen(false);
    setSubmitting(false);
    await refresh();
  }

  async function handleAction(id: string, action: "complete" | "cancel") {
    await fetch(`/api/appointments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await refresh();
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <Button variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialogOpen(true)}>
          Nieuwe afspraak
        </Button>
      )}

      {appointments === null && <SkeletonList rows={2} />}
      {appointments !== null && appointments.length === 0 && (
        <EmptyState icon={<CalendarClock className="h-5 w-5" />} title="Geen afspraken voor deze klant" description="Plan de eerste afspraak hierboven." />
      )}

      {appointments !== null && appointments.length > 0 && (
        <div className="cc-card divide-y divide-border-subtle">
          {appointments.map((appointment) => (
            <div key={appointment.id} className="cc-table-row flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-primary">{appointment.title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-tertiary">
                  <span>{formatDateTime(appointment.startsAt)}</span>
                  <span>·</span>
                  <span>{appointment.assignedTo.name}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={STATUS_TONE[appointment.status]}>{STATUS_LABEL[appointment.status]}</Badge>
                {canEdit && appointment.status === "SCHEDULED" && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => handleAction(appointment.id, "complete")}>
                      Voltooien
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleAction(appointment.id, "cancel")}>
                      Annuleren
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Nieuwe afspraak"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={submitting} disabled={title.trim().length === 0 || !assignedToId || !startsAt} onClick={handleCreate}>
              Afspraak plannen
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input label="Titel" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bijv. Bezoek showroom" autoFocus />
          <Textarea label="Omschrijving (optioneel)" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            <Input label="Einde (optioneel)" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </div>
          <Select label="Toegewezen aan" value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
            <option value="">Kies medewerker…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </div>
      </Dialog>
    </div>
  );
}

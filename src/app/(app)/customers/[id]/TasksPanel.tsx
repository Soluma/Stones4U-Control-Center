"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckSquare, Plus } from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { formatDate } from "@/lib/format";

type Task = {
  id: string;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  dueAt: string | null;
  assignedTo: { id: string; name: string };
  createdBy: { id: string; name: string };
};

type AssignableUser = { id: string; name: string };

const STATUS_TONE: Record<Task["status"], "neutral" | "accent" | "success" | "danger" | "warning"> = {
  OPEN: "neutral",
  IN_PROGRESS: "accent",
  WAITING: "warning",
  DONE: "success",
  CANCELLED: "danger",
};

const STATUS_LABEL: Record<Task["status"], string> = {
  OPEN: "Open",
  IN_PROGRESS: "Bezig",
  WAITING: "Wacht",
  DONE: "Afgerond",
  CANCELLED: "Geannuleerd",
};

const PRIORITY_TONE: Record<Task["priority"], "neutral" | "warning" | "danger"> = {
  LOW: "neutral",
  NORMAL: "neutral",
  HIGH: "warning",
  URGENT: "danger",
};

const PRIORITY_LABEL: Record<Task["priority"], string> = {
  LOW: "Laag",
  NORMAL: "Normaal",
  HIGH: "Hoog",
  URGENT: "Urgent",
};

export function TasksPanel({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("NORMAL");
  const [assignedToId, setAssignedToId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/customers/${customerId}/tasks`);
    const data = await response.json();
    setTasks(data.tasks ?? []);
  }, [customerId]);

  useEffect(() => {
    void refresh();
    fetch("/api/users/assignable")
      .then((r) => r.json())
      .then((data) => setUsers(data.users ?? []));
  }, [refresh]);

  async function handleCreate() {
    if (title.trim().length === 0 || !assignedToId) return;
    setSubmitting(true);
    await fetch(`/api/customers/${customerId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        priority,
        assignedToId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
      }),
    });
    setTitle("");
    setPriority("NORMAL");
    setDueAt("");
    setDialogOpen(false);
    setSubmitting(false);
    await refresh();
  }

  async function handleStatusChange(taskId: string, status: Task["status"]) {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await refresh();
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <Button variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialogOpen(true)}>
          Nieuwe taak
        </Button>
      )}

      {tasks === null && <SkeletonList rows={2} />}
      {tasks !== null && tasks.length === 0 && (
        <EmptyState icon={<CheckSquare className="h-5 w-5" />} title="Geen taken voor deze klant" description="Nog geen taken aangemaakt." />
      )}

      {tasks !== null && tasks.length > 0 && (
      <div className="cc-card divide-y divide-border-subtle">
        {tasks.map((task) => {
          const overdue = task.dueAt && new Date(task.dueAt) < new Date() && task.status !== "DONE" && task.status !== "CANCELLED";
          return (
            <div key={task.id} className="cc-table-row flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-primary">{task.title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-tertiary">
                  <StatusDot tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</StatusDot>
                  <span>·</span>
                  <span>{task.assignedTo.name}</span>
                  <span>·</span>
                  <span className={overdue ? "font-medium text-danger-500" : undefined}>
                    {task.dueAt ? formatDate(task.dueAt) : "geen deadline"}
                    {overdue && " (achterstallig)"}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Badge>
                {canEdit && task.status !== "DONE" && task.status !== "CANCELLED" && (
                  <Button variant="ghost" size="sm" onClick={() => handleStatusChange(task.id, "DONE")}>
                    Afronden
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Nieuwe taak"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={submitting} disabled={title.trim().length === 0 || !assignedToId} onClick={handleCreate}>
              Taak aanmaken
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input label="Titel" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bijv. Klant terugbellen over levering" autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Toewijzen aan" value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
              <option value="">Kies medewerker…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
            <Select label="Prioriteit" value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
              <option value="LOW">Laag</option>
              <option value="NORMAL">Normaal</option>
              <option value="HIGH">Hoog</option>
              <option value="URGENT">Urgent</option>
            </Select>
          </div>
          <Input label="Deadline (optioneel)" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </div>
      </Dialog>
    </div>
  );
}

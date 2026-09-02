"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
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

export function TasksPanel({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
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
        assignedToId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
      }),
    });
    setTitle("");
    setDueAt("");
    setShowForm(false);
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
        <div>
          {!showForm ? (
            <button onClick={() => setShowForm(true)} className="cc-btn-secondary">
              + Nieuwe taak
            </button>
          ) : (
            <div className="cc-card space-y-3 p-4">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Taakomschrijving" className="cc-input" autoFocus />
              <div className="flex gap-3">
                <select value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)} className="cc-input">
                  <option value="">Toewijzen aan…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
                <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="cc-input" />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowForm(false)} className="cc-btn-secondary">
                  Annuleren
                </button>
                <button onClick={handleCreate} disabled={submitting} className="cc-btn-primary">
                  {submitting ? "Aanmaken…" : "Taak aanmaken"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tasks === null && <p className="text-sm text-ink-tertiary">Taken laden…</p>}
      {tasks !== null && tasks.length === 0 && (
        <EmptyState title="Geen taken voor deze klant" description="Nog geen taken aangemaakt." />
      )}

      <div className="cc-card divide-y divide-border-subtle">
        {tasks?.map((task) => {
          const overdue = task.dueAt && new Date(task.dueAt) < new Date() && task.status !== "DONE" && task.status !== "CANCELLED";
          return (
            <div key={task.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-primary">{task.title}</p>
                <p className="text-xs text-ink-tertiary">
                  {task.assignedTo.name} · {task.dueAt ? formatDate(task.dueAt) : "geen deadline"}
                  {overdue && <span className="ml-1 font-medium text-danger-500">achterstallig</span>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[task.status]}>{task.status}</Badge>
                {canEdit && task.status !== "DONE" && task.status !== "CANCELLED" && (
                  <button onClick={() => handleStatusChange(task.id, "DONE")} className="cc-btn-ghost text-xs">
                    Afronden
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

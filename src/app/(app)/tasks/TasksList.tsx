"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, CheckSquare, Search } from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { formatDate } from "@/lib/format";
import { customerDisplayName } from "@/modules/crm/customer-identity";

type Task = {
  id: string;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  dueAt: string | null;
  assignedTo: { id: string; name: string };
  createdBy: { id: string; name: string };
  customerProfile: { id: string; displayName: string | null; companyName: string | null; customerTypeOverride: "INDIVIDUAL" | "ORGANIZATION" | null } | null;
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

const TAB_ITEMS = [
  { key: "mine", label: "Mijn taken" },
  { key: "assigned", label: "Toegewezen" },
  { key: "created", label: "Aangemaakt" },
  { key: "overdue", label: "Achterstallig" },
];

export function TasksList({ initialTab, isAdmin, canCreate }: { initialTab: string; isAdmin: boolean; canCreate: boolean }) {
  const [tab, setTab] = useState(initialTab);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("NORMAL");
  const [assignedToId, setAssignedToId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"dueAt" | "priority" | "createdAt">("dueAt");

  const tabs = isAdmin ? [...TAB_ITEMS, { key: "all", label: "Alle taken" }] : TAB_ITEMS;

  const refresh = useCallback(async () => {
    setTasks(null);
    const response = await fetch(`/api/tasks?filter=${tab}`);
    const data = await response.json();
    setTasks(data.tasks ?? []);
  }, [tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (canCreate) {
      fetch("/api/users/assignable")
        .then((r) => r.json())
        .then((data) => setUsers(data.users ?? []));
    }
  }, [canCreate]);

  async function handleComplete(taskId: string) {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    await refresh();
  }

  async function handleCreate() {
    if (title.trim().length === 0 || !assignedToId) return;
    setSubmitting(true);
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, priority, assignedToId, dueAt: dueAt ? new Date(dueAt).toISOString() : undefined }),
    });
    setTitle("");
    setPriority("NORMAL");
    setDueAt("");
    setDialogOpen(false);
    setSubmitting(false);
    await refresh();
  }

  const priorityRank: Record<Task["priority"], number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  const filteredTasks = (tasks ?? [])
    .filter((task) => task.title.toLowerCase().includes(query.trim().toLowerCase()))
    .slice()
    .sort((a, b) => {
      if (sortBy === "priority") return priorityRank[a.priority] - priorityRank[b.priority];
      if (sortBy === "createdAt") return b.id.localeCompare(a.id); // stable-ish fallback; list already arrives sorted per filter
      const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      return aDue - bDue;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs items={tabs} active={tab} onSelect={setTab} />
        {canCreate && (
          <Button variant="secondary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialogOpen(true)} className="shrink-0">
            Nieuwe taak
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Zoek op titel…"
            className="cc-input py-1.5 pl-8 text-sm"
          />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="cc-input w-auto py-1.5 text-sm">
          <option value="dueAt">Sorteer: deadline</option>
          <option value="priority">Sorteer: prioriteit</option>
          <option value="createdAt">Sorteer: nieuwste eerst</option>
        </select>
      </div>

      {tasks === null && <SkeletonList rows={4} />}
      {tasks !== null && filteredTasks.length === 0 && (
        <EmptyState icon={<CheckSquare className="h-5 w-5" />} title="Geen taken" description="Er zijn hier geen taken te tonen." />
      )}

      {tasks !== null && filteredTasks.length > 0 && (
      <div className="cc-card divide-y divide-border-subtle">
        {filteredTasks.map((task) => {
          const overdue = task.dueAt && new Date(task.dueAt) < new Date() && task.status !== "DONE" && task.status !== "CANCELLED";
          return (
            <div key={task.id} className="cc-table-row flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <Link href={`/tasks/${task.id}`} className="block truncate text-sm font-medium text-ink-primary hover:underline">
                  {task.title}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-tertiary">
                  <StatusDot tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</StatusDot>
                  {task.customerProfile && (
                    <>
                      <span>·</span>
                      <Link href={`/customers/${task.customerProfile.id}`} className="text-accent-600 hover:underline">
                        {customerDisplayName(task.customerProfile)}
                      </Link>
                    </>
                  )}
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
                {task.status !== "DONE" && task.status !== "CANCELLED" && (
                  <Button variant="ghost" size="sm" onClick={() => handleComplete(task.id)}>
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
          <Input label="Titel" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Taakomschrijving" autoFocus />
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

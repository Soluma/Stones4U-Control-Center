"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
  customerProfile: { id: string; displayName: string | null; companyName: string | null } | null;
};

const STATUS_TONE: Record<Task["status"], "neutral" | "accent" | "success" | "danger" | "warning"> = {
  OPEN: "neutral",
  IN_PROGRESS: "accent",
  WAITING: "warning",
  DONE: "success",
  CANCELLED: "danger",
};

const TABS: { key: string; label: string }[] = [
  { key: "mine", label: "Mijn taken" },
  { key: "assigned", label: "Toegewezen" },
  { key: "created", label: "Aangemaakt" },
  { key: "overdue", label: "Achterstallig" },
];

export function TasksList({ initialTab, isAdmin }: { initialTab: string; isAdmin: boolean }) {
  const [tab, setTab] = useState(initialTab);
  const [tasks, setTasks] = useState<Task[] | null>(null);

  const tabs = isAdmin ? [...TABS, { key: "all", label: "Alle taken" }] : TABS;

  const refresh = useCallback(async () => {
    setTasks(null);
    const response = await fetch(`/api/tasks?filter=${tab}`);
    const data = await response.json();
    setTasks(data.tasks ?? []);
  }, [tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleComplete(taskId: string) {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    await refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border-subtle">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key ? "border-accent-500 text-ink-primary" : "border-transparent text-ink-tertiary hover:text-ink-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tasks === null && <p className="text-sm text-ink-tertiary">Taken laden…</p>}
      {tasks !== null && tasks.length === 0 && <EmptyState title="Geen taken" description="Er zijn hier geen taken te tonen." />}

      <div className="cc-card divide-y divide-border-subtle">
        {tasks?.map((task) => {
          const overdue = task.dueAt && new Date(task.dueAt) < new Date() && task.status !== "DONE" && task.status !== "CANCELLED";
          return (
            <div key={task.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-primary">{task.title}</p>
                <p className="text-xs text-ink-tertiary">
                  {task.customerProfile && (
                    <Link href={`/customers/${task.customerProfile.id}`} className="text-accent-600 hover:underline">
                      {task.customerProfile.displayName ?? task.customerProfile.companyName ?? "Klant"}
                    </Link>
                  )}
                  {task.customerProfile && " · "}
                  {task.assignedTo.name} · {task.dueAt ? formatDate(task.dueAt) : "geen deadline"}
                  {overdue && <span className="ml-1 font-medium text-danger-500">achterstallig</span>}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge tone={STATUS_TONE[task.status]}>{task.status}</Badge>
                {task.status !== "DONE" && task.status !== "CANCELLED" && (
                  <button onClick={() => handleComplete(task.id)} className="cc-btn-ghost text-xs">
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

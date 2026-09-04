"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckSquare, Plus } from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { formatDate } from "@/lib/format";
import { CreateTaskDialog } from "./CreateTaskDialog";

type Task = {
  id: string;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  dueAt: string | null;
  assignedTo: { id: string; name: string };
  createdBy: { id: string; name: string };
};

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

export function TasksPanel({
  customerId,
  opportunityId,
  canEdit,
}: {
  customerId?: string;
  opportunityId?: string;
  canEdit: boolean;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Phase 4a — opportunity-scoped when opportunityId is given, otherwise
  // the existing customer-scoped endpoint (docs/platform-discovery/33).
  const basePath = opportunityId ? `/api/opportunities/${opportunityId}` : `/api/customers/${customerId}`;

  const refresh = useCallback(async () => {
    const response = await fetch(`${basePath}/tasks`);
    const data = await response.json();
    setTasks(data.tasks ?? []);
  }, [basePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
                <Link href={`/tasks/${task.id}`} className="block truncate text-sm font-medium text-ink-primary hover:underline">
                  {task.title}
                </Link>
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

      <CreateTaskDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={refresh} basePath={basePath} />
    </div>
  );
}

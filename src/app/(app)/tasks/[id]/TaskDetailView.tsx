"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, RotateCcw, XCircle, Plus, Trash2 } from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Avatar";
import { formatDate, formatDateTime } from "@/lib/format";

type TaskStatus = "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

type ChecklistItem = { id: string; title: string; done: boolean };
type Comment = { id: string; body: string; createdAt: string; author: { id: string; name: string } };

type TaskDetail = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  tags: string[];
  assignedTo: { id: string; name: string };
  createdBy: { id: string; name: string };
  customerProfile: { id: string; displayName: string | null; companyName: string | null } | null;
  checklistItems: ChecklistItem[];
  comments: Comment[];
};

const STATUS_TONE: Record<TaskStatus, "neutral" | "accent" | "success" | "danger" | "warning"> = {
  OPEN: "neutral",
  IN_PROGRESS: "accent",
  WAITING: "warning",
  DONE: "success",
  CANCELLED: "danger",
};
const STATUS_LABEL: Record<TaskStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "Bezig",
  WAITING: "Wacht",
  DONE: "Afgerond",
  CANCELLED: "Geannuleerd",
};
const PRIORITY_LABEL: Record<TaskPriority, string> = { LOW: "Laag", NORMAL: "Normaal", HIGH: "Hoog", URGENT: "Urgent" };
const PRIORITY_TONE: Record<TaskPriority, "neutral" | "warning" | "danger"> = { LOW: "neutral", NORMAL: "neutral", HIGH: "warning", URGENT: "danger" };

export function TaskDetailView({ initialTask, canEdit }: { initialTask: TaskDetail; canEdit: boolean }) {
  const [task, setTask] = useState(initialTask);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description ?? "");
  const [priorityDraft, setPriorityDraft] = useState<TaskPriority>(task.priority);
  const [dueAtDraft, setDueAtDraft] = useState(task.dueAt ? task.dueAt.slice(0, 10) : "");
  const [newChecklistTitle, setNewChecklistTitle] = useState("");
  const [newComment, setNewComment] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/tasks/${task.id}`);
    if (response.ok) setTask(await response.json());
  }, [task.id]);

  async function saveDetails() {
    setBusy(true);
    await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: titleDraft,
        description: descriptionDraft || null,
        priority: priorityDraft,
        dueAt: dueAtDraft ? new Date(dueAtDraft).toISOString() : null,
      }),
    });
    setEditing(false);
    setBusy(false);
    await refresh();
    router.refresh();
  }

  async function setStatus(status: TaskStatus) {
    setBusy(true);
    await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    setBusy(false);
    await refresh();
  }

  async function addChecklistItem() {
    if (newChecklistTitle.trim().length === 0) return;
    setBusy(true);
    await fetch(`/api/tasks/${task.id}/checklist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: newChecklistTitle }) });
    setNewChecklistTitle("");
    setBusy(false);
    await refresh();
  }

  async function toggleChecklistItem(itemId: string, done: boolean) {
    await fetch(`/api/tasks/${task.id}/checklist/${itemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done }) });
    await refresh();
  }

  async function removeChecklistItem(itemId: string) {
    await fetch(`/api/tasks/${task.id}/checklist/${itemId}`, { method: "DELETE" });
    await refresh();
  }

  async function addComment() {
    if (newComment.trim().length === 0) return;
    setBusy(true);
    await fetch(`/api/tasks/${task.id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: newComment }) });
    setNewComment("");
    setBusy(false);
    await refresh();
  }

  const doneCount = task.checklistItems.filter((i) => i.done).length;
  const isOpen = task.status !== "DONE" && task.status !== "CANCELLED";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href="/tasks" className="inline-flex items-center gap-1.5 text-sm text-ink-tertiary hover:text-ink-secondary">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Terug naar taken
      </Link>

      <div className="cc-card p-5">
        {editing ? (
          <div className="space-y-3">
            <Input label="Titel" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
            <Textarea label="Omschrijving" value={descriptionDraft} onChange={(e) => setDescriptionDraft(e.target.value)} rows={3} />
            <div className="grid grid-cols-2 gap-3">
              <Select label="Prioriteit" value={priorityDraft} onChange={(e) => setPriorityDraft(e.target.value as TaskPriority)}>
                {(["LOW", "NORMAL", "HIGH", "URGENT"] as const).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
              <Input label="Deadline" type="date" value={dueAtDraft} onChange={(e) => setDueAtDraft(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
                Annuleren
              </Button>
              <Button variant="primary" size="sm" loading={busy} onClick={saveDetails}>
                Opslaan
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-ink-primary">{task.title}</h1>
                {task.description && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-secondary">{task.description}</p>}
              </div>
              {canEdit && (
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  Bewerken
                </Button>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-subtle pt-4 text-sm">
              <Badge tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Badge>
              <StatusDot tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</StatusDot>
              <span className="text-ink-tertiary">Toegewezen: <span className="font-medium text-ink-secondary">{task.assignedTo.name}</span></span>
              <span className="text-ink-tertiary">Aangemaakt door: <span className="font-medium text-ink-secondary">{task.createdBy.name}</span></span>
              {task.dueAt && <span className="text-ink-tertiary">Deadline: <span className="font-medium text-ink-secondary">{formatDate(task.dueAt)}</span></span>}
              {task.customerProfile && (
                <Link href={`/customers/${task.customerProfile.id}`} className="text-accent-600 hover:underline">
                  {task.customerProfile.displayName ?? task.customerProfile.companyName ?? "Klant"}
                </Link>
              )}
            </div>

            {canEdit && isOpen && (
              <div className="mt-4 flex gap-2 border-t border-border-subtle pt-4">
                <Button variant="secondary" size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} loading={busy} onClick={() => setStatus("DONE")}>
                  Afronden
                </Button>
                <Button variant="ghost" size="sm" icon={<XCircle className="h-3.5 w-3.5" />} loading={busy} onClick={() => setStatus("CANCELLED")}>
                  Annuleren
                </Button>
              </div>
            )}
            {canEdit && !isOpen && (
              <div className="mt-4 border-t border-border-subtle pt-4">
                <Button variant="ghost" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy} onClick={() => setStatus("OPEN")}>
                  Heropenen
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="cc-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-secondary">
            Checklist {task.checklistItems.length > 0 && <span className="text-ink-tertiary">({doneCount}/{task.checklistItems.length})</span>}
          </h2>
        </div>
        <div className="space-y-1.5">
          {task.checklistItems.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-hover">
              <input
                type="checkbox"
                checked={item.done}
                disabled={!canEdit}
                onChange={(e) => toggleChecklistItem(item.id, e.target.checked)}
                className="h-4 w-4 rounded border-border cc-focus-ring"
              />
              <span className={`flex-1 text-sm ${item.done ? "text-ink-disabled line-through" : "text-ink-primary"}`}>{item.title}</span>
              {canEdit && (
                <IconButton icon={<Trash2 className="h-3 w-3" />} label="Item verwijderen" tone="danger" onClick={() => removeChecklistItem(item.id)} />
              )}
            </div>
          ))}
          {task.checklistItems.length === 0 && <p className="px-1.5 text-sm text-ink-tertiary">Nog geen checklist-items.</p>}
        </div>
        {canEdit && (
          <div className="mt-3 flex items-end gap-2 border-t border-border-subtle pt-3">
            <div className="flex-1">
              <Input value={newChecklistTitle} onChange={(e) => setNewChecklistTitle(e.target.value)} placeholder="Nieuw item…" onKeyDown={(e) => e.key === "Enter" && addChecklistItem()} />
            </div>
            <Button variant="secondary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={newChecklistTitle.trim().length === 0 || busy} onClick={addChecklistItem}>
              Toevoegen
            </Button>
          </div>
        )}
      </div>

      <div className="cc-card p-5">
        <h2 className="mb-3 text-sm font-medium text-ink-secondary">Opmerkingen</h2>
        <div className="space-y-3">
          {task.comments.map((comment) => (
            <div key={comment.id} className="flex gap-2.5">
              <Avatar name={comment.author.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-ink-tertiary">
                  <span className="font-medium text-ink-secondary">{comment.author.name}</span> · {formatDateTime(comment.createdAt)}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-primary">{comment.body}</p>
              </div>
            </div>
          ))}
          {task.comments.length === 0 && <p className="text-sm text-ink-tertiary">Nog geen opmerkingen.</p>}
        </div>
        {canEdit && (
          <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
            <Textarea value={newComment} onChange={(e) => setNewComment(e.target.value)} rows={2} placeholder="Opmerking plaatsen…" />
            <div className="flex justify-end">
              <Button variant="primary" size="sm" loading={busy} disabled={newComment.trim().length === 0} onClick={addComment}>
                Plaatsen
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

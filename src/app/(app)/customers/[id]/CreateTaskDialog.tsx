"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { notifyTasksChanged } from "@/lib/task-events";
import { TASK_DESCRIPTION_MAX } from "@/modules/tasks/task-input";

export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
type AssignableUser = { id: string; name: string };

// Phase 6c — extracted from TasksPanel.tsx's "Nieuwe taak" dialog (build
// spec §1.6) so the timeline/Recent-block quick actions can open the exact
// same create-task flow with a prefilled title/contact, instead of a
// second, drifting implementation. Same fields, same validation, same
// no-default-assignee/no-default-due-date behavior as before this
// extraction — assignedToId is still always chosen explicitly by the user.
//
// Also the central /tasks "Nieuwe taak" (basePath "/api" → POST /api/tasks),
// so every create-task flow has the same fields, including the long
// description, and cannot drift apart again.
export function CreateTaskDialog({
  open,
  onClose,
  onCreated,
  basePath,
  initialTitle,
  initialCustomerContactId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
  // e.g. `/api/customers/${customerId}`, `/api/opportunities/${opportunityId}`,
  // or "/api" for the central task list
  basePath: string;
  initialTitle?: string;
  // Only ever set on an exact, unambiguous contact match (never guessed) —
  // omitted/null means the dialog simply has no contact prefilled.
  initialCustomerContactId?: string | null;
}) {
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [priority, setPriority] = useState<TaskPriority>("NORMAL");
  const [assignedToId, setAssignedToId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Re-seed the form from props every time the dialog opens, so a prefilled
  // title from a previous quick action never leaks into the next open.
  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle ?? "");
    setDescription("");
    setError(null);
    setPriority("NORMAL");
    setAssignedToId("");
    setDueAt("");
  }, [open, initialTitle]);

  useEffect(() => {
    fetch("/api/users/assignable")
      .then((r) => r.json())
      .then((data) => setUsers(data.users ?? []));
  }, []);

  async function handleCreate() {
    if (title.trim().length === 0 || !assignedToId || description.length > TASK_DESCRIPTION_MAX) return;
    setSubmitting(true);
    setError(null);
    const response = await fetch(`${basePath}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        // Exactly as typed — line breaks included; omitted when empty.
        description: description.trim().length > 0 ? description : undefined,
        priority,
        assignedToId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        customerContactId: initialCustomerContactId ?? undefined,
      }),
    });
    setSubmitting(false);
    if (!response.ok) {
      setError("De taak kon niet worden opgeslagen. Controleer de velden en probeer het opnieuw.");
      return;
    }
    notifyTasksChanged();
    onClose();
    await onCreated();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nieuwe taak"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={submitting} disabled={title.trim().length === 0 || !assignedToId || description.length > TASK_DESCRIPTION_MAX} onClick={handleCreate}>
            Taak aanmaken
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          label="Titel"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Bijv. Klant terugbellen over levering"
          maxLength={200}
          autoFocus
          data-autofocus
        />
        <Textarea
          label="Omschrijving (optioneel)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={7}
          maxLength={TASK_DESCRIPTION_MAX}
          placeholder="Beschrijf wat er moet gebeuren, wat met de klant is afgesproken en welke informatie belangrijk is voor degene die de taak uitvoert."
          hint={`${description.length}/${TASK_DESCRIPTION_MAX} tekens`}
          className="resize-y"
        />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Toewijzen aan" value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
            <option value="">Kies medewerker…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <Select label="Prioriteit" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            <option value="LOW">Laag</option>
            <option value="NORMAL">Normaal</option>
            <option value="HIGH">Hoog</option>
            <option value="URGENT">Urgent</option>
          </Select>
        </div>
        <Input label="Deadline (optioneel)" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        {error && (
          <p role="alert" className="text-sm text-danger-500">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

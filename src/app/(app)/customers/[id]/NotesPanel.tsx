"use client";

import { useCallback, useEffect, useState } from "react";
import { StickyNote, Pencil, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { RichTextView } from "@/components/ui/RichTextView";
import { formatDateTime } from "@/lib/format";
import type { RichTextDoc } from "@/platform/security/rich-text";

type Note = {
  id: string;
  bodyJson: RichTextDoc;
  bodyText: string;
  editedAt: string | null;
  createdAt: string;
  author: { id: string; name: string };
};

export function NotesPanel({
  customerId,
  opportunityId,
  canEdit,
}: {
  customerId?: string;
  opportunityId?: string;
  canEdit: boolean;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // Phase 4a — opportunity-scoped when opportunityId is given.
  const basePath = opportunityId ? `/api/opportunities/${opportunityId}` : `/api/customers/${customerId}`;

  const refresh = useCallback(async () => {
    const response = await fetch(`${basePath}/notes`);
    const data = await response.json();
    setNotes(data.notes ?? []);
  }, [basePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    if (draft.trim().length === 0) return;
    setSubmitting(true);
    await fetch(`${basePath}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bodyPlainText: draft }),
    });
    setDraft("");
    setSubmitting(false);
    await refresh();
  }

  async function handleUpdate(noteId: string) {
    if (editDraft.trim().length === 0) return;
    await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bodyPlainText: editDraft }),
    });
    setEditingId(null);
    await refresh();
  }

  async function handleDelete(noteId: string) {
    if (!confirm("Deze notitie verwijderen?")) return;
    await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="cc-card p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Nieuwe notitie… (**vet**, *cursief*, `code`, of regels beginnend met &quot;- &quot; voor een lijst)"
            className="cc-input resize-none leading-relaxed"
          />
          <div className="mt-2.5 flex justify-end">
            <Button variant="primary" onClick={handleCreate} loading={submitting} disabled={draft.trim().length === 0}>
              Notitie toevoegen
            </Button>
          </div>
        </div>
      )}

      {notes === null && <SkeletonList rows={2} />}

      {notes !== null && notes.length === 0 && (
        <EmptyState icon={<StickyNote className="h-5 w-5" />} title="Nog geen notities voor deze klant" description="Voeg de eerste notitie hierboven toe." />
      )}

      <div className="space-y-3">
        {notes?.map((note) => (
          <div key={note.id} className="cc-card p-4">
            {editingId === note.id ? (
              <div className="space-y-2.5">
                <textarea
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  rows={3}
                  className="cc-input resize-none leading-relaxed"
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                    Annuleren
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => handleUpdate(note.id)}>
                    Opslaan
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <RichTextView doc={note.bodyJson} />
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Avatar name={note.author.name} size="sm" />
                    <p className="text-xs text-ink-tertiary">
                      <span className="font-medium text-ink-secondary">{note.author.name}</span> · {formatDateTime(note.createdAt)}
                      {note.editedAt ? " · bewerkt" : ""}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex gap-1">
                      <IconButton
                        icon={<Pencil className="h-3.5 w-3.5" />}
                        label="Notitie bewerken"
                        onClick={() => {
                          setEditingId(note.id);
                          setEditDraft(note.bodyText);
                        }}
                      />
                      <IconButton
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        label="Notitie verwijderen"
                        tone="danger"
                        onClick={() => handleDelete(note.id)}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

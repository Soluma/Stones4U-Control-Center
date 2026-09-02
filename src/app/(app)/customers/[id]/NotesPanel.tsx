"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
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

export function NotesPanel({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/customers/${customerId}/notes`);
    const data = await response.json();
    setNotes(data.notes ?? []);
  }, [customerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    if (draft.trim().length === 0) return;
    setSubmitting(true);
    await fetch(`/api/customers/${customerId}/notes`, {
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
            className="cc-input resize-none"
          />
          <div className="mt-2 flex justify-end">
            <button onClick={handleCreate} disabled={submitting || draft.trim().length === 0} className="cc-btn-primary">
              {submitting ? "Opslaan…" : "Notitie toevoegen"}
            </button>
          </div>
        </div>
      )}

      {notes === null && <p className="text-sm text-ink-tertiary">Notities laden…</p>}

      {notes !== null && notes.length === 0 && (
        <EmptyState title="Nog geen notities voor deze klant" description="Voeg de eerste notitie hierboven toe." />
      )}

      <div className="space-y-3">
        {notes?.map((note) => (
          <div key={note.id} className="cc-card p-4">
            {editingId === note.id ? (
              <div className="space-y-2">
                <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={3} className="cc-input resize-none" />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setEditingId(null)} className="cc-btn-secondary">
                    Annuleren
                  </button>
                  <button onClick={() => handleUpdate(note.id)} className="cc-btn-primary">
                    Opslaan
                  </button>
                </div>
              </div>
            ) : (
              <>
                <RichTextView doc={note.bodyJson} />
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-xs text-ink-tertiary">
                    {note.author.name} · {formatDateTime(note.createdAt)}
                    {note.editedAt ? " · bewerkt" : ""}
                  </p>
                  {canEdit && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setEditingId(note.id);
                          setEditDraft(note.bodyText);
                        }}
                        className="cc-btn-ghost text-xs"
                      >
                        Bewerken
                      </button>
                      <button onClick={() => handleDelete(note.id)} className="cc-btn-ghost text-xs text-danger-500">
                        Verwijderen
                      </button>
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

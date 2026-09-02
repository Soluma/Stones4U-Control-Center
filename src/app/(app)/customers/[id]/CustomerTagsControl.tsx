"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Tag as TagIcon, Plus, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { IconButton } from "@/components/ui/IconButton";

type TagOption = { id: string; name: string; color: string | null };

function TagChip({ tag, onRemove }: { tag: TagOption; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium"
      style={
        tag.color
          ? { backgroundColor: `${tag.color}1a`, borderColor: `${tag.color}55`, color: tag.color }
          : undefined
      }
    >
      {!tag.color && <TagIcon className="h-3 w-3 text-ink-tertiary" aria-hidden />}
      {tag.name}
      {onRemove && (
        <button type="button" onClick={onRemove} className="ml-0.5 rounded-sm hover:opacity-70" aria-label={`${tag.name} verwijderen`}>
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

export function CustomerTagsControl({
  customerProfileId,
  assignedTags,
  allTags,
  canEdit,
}: {
  customerProfileId: string;
  assignedTags: TagOption[];
  allTags: TagOption[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const assignedIds = new Set(assignedTags.map((t) => t.id));

  async function toggleTag(tagId: string, assigned: boolean) {
    setBusy(true);
    await fetch(`/api/customers/${customerProfileId}/tags`, {
      method: assigned ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId }),
    });
    setBusy(false);
    router.refresh();
  }

  async function createTag() {
    if (newTagName.trim().length === 0) return;
    setBusy(true);
    const response = await fetch("/api/customer-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTagName.trim() }),
    });
    if (response.ok) {
      const tag = await response.json();
      await fetch(`/api/customers/${customerProfileId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagId: tag.id }),
      });
    }
    setNewTagName("");
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {assignedTags.map((tag) => (
        <TagChip key={tag.id} tag={tag} onRemove={canEdit ? () => toggleTag(tag.id, true) : undefined} />
      ))}
      {canEdit && (
        <>
          <IconButton icon={<Plus className="h-3.5 w-3.5" />} label="Tags beheren" onClick={() => setOpen(true)} />
          <Dialog open={open} onClose={() => setOpen(false)} title="Tags beheren">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {allTags.length === 0 && <p className="text-sm text-ink-tertiary">Nog geen tags aangemaakt.</p>}
                {allTags.map((tag) => {
                  const assigned = assignedIds.has(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      disabled={busy}
                      onClick={() => toggleTag(tag.id, assigned)}
                      className={`rounded-md border px-2 py-1 text-xs font-medium transition ${assigned ? "border-accent-500 bg-accent-50 text-accent-700" : "border-border bg-surface text-ink-secondary hover:bg-surface-hover"}`}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-end gap-2 border-t border-border-subtle pt-3">
                <div className="flex-1">
                  <Input value={newTagName} onChange={(e) => setNewTagName(e.target.value)} placeholder="Nieuwe tag…" />
                </div>
                <Button variant="secondary" size="sm" onClick={createTag} disabled={newTagName.trim().length === 0 || busy}>
                  Aanmaken
                </Button>
              </div>
            </div>
          </Dialog>
        </>
      )}
    </div>
  );
}

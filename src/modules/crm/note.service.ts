import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import { parsePlainTextToRichDoc, richDocToPlainText, richTextDocSchema, type RichTextDoc } from "@/platform/security/rich-text";
import { resolveCustomerProfileIdForOpportunity } from "@/modules/opportunities/opportunity.service";
import { assertContactBelongsToCustomer } from "@/modules/crm/customer-contact.service";
import type { Role, Prisma } from "@/generated/prisma";

type Actor = { id: string; role: Role };

// Per docs/platform-discovery/25 §6: AGENT may edit/delete only their own
// notes; ADMIN may edit/delete any note. Found missing during the Phase 1
// production readiness review — updateNote/deleteNote previously applied no
// ownership check at all, letting any AGENT edit or delete any other AGENT's
// note (docs/build/PHASE-1-PRODUCTION-READINESS.md).
function assertCanModifyNote(note: { authorId: string }, actor: Actor) {
  if (actor.role === "ADMIN") return;
  if (actor.id === note.authorId) return;
  throw new ForbiddenError("Alleen de auteur of een beheerder mag deze notitie bewerken of verwijderen.");
}

// Phase 6d — pinned notes always first (newest-pinned-first within that
// group), unpinned notes keep their existing createdAt-desc order below.
// One query, DB-side multi-key sort — no in-memory re-sort, no N+1.
const noteOrderBy: Prisma.NoteOrderByWithRelationInput[] = [{ isPinned: "desc" }, { pinnedAt: "desc" }, { createdAt: "desc" }];

export async function listNotesForCustomer(customerProfileId: string) {
  return prisma.note.findMany({
    where: { customerProfileId, deletedAt: null },
    include: { author: { select: { id: true, name: true } }, pinnedBy: { select: { id: true, name: true } } },
    orderBy: noteOrderBy,
  });
}

/** Phase 4a — opportunity-scoped notes for the Opportunity detail page. */
export async function listNotesForOpportunity(opportunityId: string) {
  return prisma.note.findMany({
    where: { opportunityId, deletedAt: null },
    include: { author: { select: { id: true, name: true } }, pinnedBy: { select: { id: true, name: true } } },
    orderBy: noteOrderBy,
  });
}

export async function createNote(input: {
  // Required unless opportunityId is set (ADR-009 §5).
  customerProfileId?: string;
  authorId: string;
  bodyPlainText: string;
  tags?: string[];
  // Phase 4a — when set, customerProfileId is ALWAYS derived from the
  // opportunity, never the caller-supplied value.
  opportunityId?: string | null;
  // Phase 4c — optional, server-verified against the resolved
  // customerProfileId (build spec §21).
  customerContactId?: string | null;
}) {
  const bodyJson = parsePlainTextToRichDoc(input.bodyPlainText);
  const bodyText = richDocToPlainText(bodyJson);
  const customerProfileId = input.opportunityId
    ? await resolveCustomerProfileIdForOpportunity(input.opportunityId)
    : input.customerProfileId!;

  if (input.customerContactId) {
    await assertContactBelongsToCustomer(input.customerContactId, customerProfileId);
  }

  const note = await prisma.$transaction(async (tx) => {
    const created = await tx.note.create({
      data: {
        customerProfileId,
        authorId: input.authorId,
        bodyJson: bodyJson as never,
        bodyText,
        tags: input.tags ?? [],
        opportunityId: input.opportunityId ?? null,
        customerContactId: input.customerContactId ?? null,
      },
    });

    await tx.activity.create({
      data: {
        customerProfileId,
        type: "NOTE_CREATED",
        sourceType: "CONTROL_CENTER",
        title: "Notitie toegevoegd",
        summary: truncate(bodyText, 140),
        occurredAt: created.createdAt,
        actorId: input.authorId,
        relatedNoteId: created.id,
        relatedOpportunityId: created.opportunityId,
      },
    });

    return created;
  });

  await logAudit({
    userId: input.authorId,
    action: "note.created",
    entityType: "Note",
    entityId: note.id,
    metadata: { customerProfileId },
  });

  return note;
}

export async function updateNote(
  noteId: string,
  input: { bodyPlainText: string; tags?: string[]; customerContactId?: string | null },
  actor: Actor,
) {
  const existing = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
  assertCanModifyNote(existing, actor);

  if (input.customerContactId) {
    await assertContactBelongsToCustomer(input.customerContactId, existing.customerProfileId);
  }

  const bodyJson = parsePlainTextToRichDoc(input.bodyPlainText);
  const bodyText = richDocToPlainText(bodyJson);

  const note = await prisma.$transaction(async (tx) => {
    const updated = await tx.note.update({
      where: { id: noteId },
      data: {
        bodyJson: bodyJson as never,
        bodyText,
        tags: input.tags,
        editedAt: new Date(),
        customerContactId: input.customerContactId !== undefined ? input.customerContactId : undefined,
      },
    });

    await tx.activity.create({
      data: {
        customerProfileId: updated.customerProfileId,
        type: "NOTE_UPDATED",
        sourceType: "CONTROL_CENTER",
        title: "Notitie bewerkt",
        summary: truncate(bodyText, 140),
        occurredAt: updated.updatedAt,
        actorId: actor.id,
        relatedNoteId: updated.id,
        // Phase 4B — ongoing note edits on an opportunity-linked note count
        // toward that opportunity's "last activity" for staleness purposes.
        relatedOpportunityId: updated.opportunityId,
      },
    });

    return updated;
  });

  await logAudit({
    userId: actor.id,
    action: "note.updated",
    entityType: "Note",
    entityId: note.id,
  });

  return note;
}

/** Soft delete — Note.deletedAt, never a hard DELETE, so the audit trail and
 * any activity referencing this note remain intact (unlike TelefoonSysteem's
 * notes, which cannot be deleted at all — docs/platform-discovery/21 §2). */
export async function deleteNote(noteId: string, actor: Actor) {
  const existing = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
  assertCanModifyNote(existing, actor);

  const note = await prisma.$transaction(async (tx) => {
    const deleted = await tx.note.update({ where: { id: noteId }, data: { deletedAt: new Date() } });

    await tx.activity.create({
      data: {
        customerProfileId: deleted.customerProfileId,
        type: "NOTE_DELETED",
        sourceType: "CONTROL_CENTER",
        title: "Notitie verwijderd",
        occurredAt: new Date(),
        actorId: actor.id,
        relatedNoteId: deleted.id,
        relatedOpportunityId: deleted.opportunityId,
      },
    });

    return deleted;
  });

  await logAudit({ userId: actor.id, action: "note.deleted", entityType: "Note", entityId: note.id });

  return note;
}

/** Phase 6d — pin/unpin (docs/platform-discovery/54/55). Deliberately NOT
 * gated by assertCanModifyNote(): pinning is team curation ("what should a
 * colleague know"), not content ownership — any write-capable user may pin
 * any note, regardless of who authored it (architecture doc §3). Content
 * itself (bodyJson/bodyText/authorId) is never touched here.
 *
 * Idempotent by design: pinning an already-pinned note (or unpinning an
 * already-unpinned one) is a successful no-op — pinnedAt/pinnedById are
 * never rewritten, and no audit event is written for a no-op. The
 * conditional updateMany() (same concurrency pattern as
 * assignCustomerToSelfIfUnassigned() in customer-profile.service.ts)
 * guarantees exactly one effective transition — and exactly one audit
 * event — even under a concurrent double-pin/double-unpin race: the
 * losing request's updateMany() affects zero rows and falls through to
 * the same no-op return, never a second write. */
export async function pinNote(noteId: string, actor: Actor) {
  const existing = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
  if (existing.isPinned) return existing;

  const result = await prisma.note.updateMany({
    where: { id: noteId, isPinned: false },
    data: { isPinned: true, pinnedAt: new Date(), pinnedById: actor.id },
  });

  if (result.count === 0) {
    // Lost a race to a concurrent pin — same no-op outcome, no second audit.
    return prisma.note.findUniqueOrThrow({ where: { id: noteId } });
  }

  await logAudit({
    userId: actor.id,
    action: "note.pinned",
    entityType: "Note",
    entityId: noteId,
    metadata: { customerProfileId: existing.customerProfileId },
  });

  return prisma.note.findUniqueOrThrow({ where: { id: noteId } });
}

export async function unpinNote(noteId: string, actor: Actor) {
  const existing = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
  if (!existing.isPinned) return existing;

  const result = await prisma.note.updateMany({
    where: { id: noteId, isPinned: true },
    data: { isPinned: false, pinnedAt: null, pinnedById: null },
  });

  if (result.count === 0) {
    return prisma.note.findUniqueOrThrow({ where: { id: noteId } });
  }

  await logAudit({
    userId: actor.id,
    action: "note.unpinned",
    entityType: "Note",
    entityId: noteId,
    metadata: { customerProfileId: existing.customerProfileId },
  });

  return prisma.note.findUniqueOrThrow({ where: { id: noteId } });
}

export function validateRichTextDoc(value: unknown): RichTextDoc {
  return richTextDocSchema.parse(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import { parsePlainTextToRichDoc, richDocToPlainText, richTextDocSchema, type RichTextDoc } from "@/platform/security/rich-text";
import { resolveCustomerProfileIdForOpportunity } from "@/modules/opportunities/opportunity.service";
import type { Role } from "@/generated/prisma";

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

export async function listNotesForCustomer(customerProfileId: string) {
  return prisma.note.findMany({
    where: { customerProfileId, deletedAt: null },
    include: { author: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}

/** Phase 4a — opportunity-scoped notes for the Opportunity detail page. */
export async function listNotesForOpportunity(opportunityId: string) {
  return prisma.note.findMany({
    where: { opportunityId, deletedAt: null },
    include: { author: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
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
}) {
  const bodyJson = parsePlainTextToRichDoc(input.bodyPlainText);
  const bodyText = richDocToPlainText(bodyJson);
  const customerProfileId = input.opportunityId
    ? await resolveCustomerProfileIdForOpportunity(input.opportunityId)
    : input.customerProfileId!;

  const note = await prisma.$transaction(async (tx) => {
    const created = await tx.note.create({
      data: {
        customerProfileId,
        authorId: input.authorId,
        bodyJson: bodyJson as never,
        bodyText,
        tags: input.tags ?? [],
        opportunityId: input.opportunityId ?? null,
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
  input: { bodyPlainText: string; tags?: string[] },
  actor: Actor,
) {
  const existing = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
  assertCanModifyNote(existing, actor);

  const bodyJson = parsePlainTextToRichDoc(input.bodyPlainText);
  const bodyText = richDocToPlainText(bodyJson);

  const note = await prisma.$transaction(async (tx) => {
    const updated = await tx.note.update({
      where: { id: noteId },
      data: { bodyJson: bodyJson as never, bodyText, tags: input.tags, editedAt: new Date() },
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
      },
    });

    return deleted;
  });

  await logAudit({ userId: actor.id, action: "note.deleted", entityType: "Note", entityId: note.id });

  return note;
}

export function validateRichTextDoc(value: unknown): RichTextDoc {
  return richTextDocSchema.parse(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

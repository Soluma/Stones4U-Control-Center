import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import { validateUpload, sanitizeFilename } from "@/platform/security/file-validation";
import { generateStorageKey, uploadObject, deleteObject, getSignedDownloadUrl } from "@/integrations/storage/r2";
import { resolveCustomerProfileIdForOpportunity } from "@/modules/opportunities/opportunity.service";
import type { Role } from "@/generated/prisma";

// Customer file attachments — Cloudflare R2 for bytes, Postgres for metadata
// only (docs/architecture/ADR-005, docs/platform-discovery/26 §10). Every
// mutating action here is audited; file *content* is never included in
// audit metadata (§14 of the same doc).

type Actor = { id: string; role: Role };

function assertCanDelete(file: { uploadedById: string }, actor: Actor) {
  if (actor.role === "ADMIN") return;
  if (actor.id === file.uploadedById) return;
  throw new ForbiddenError("Alleen de uploader of een beheerder mag dit bestand verwijderen.");
}

function extensionOf(filename: string): string {
  const match = /\.[a-z0-9]+$/i.exec(filename);
  return match ? match[0].toLowerCase() : "";
}

export async function listFilesForCustomer(customerProfileId: string) {
  return prisma.file.findMany({
    where: { customerProfileId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
}

/** Phase 4a — opportunity-scoped files for the Opportunity detail page. */
export async function listFilesForOpportunity(opportunityId: string) {
  return prisma.file.findMany({
    where: { opportunityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
}

export async function uploadFile(
  input: {
    // Required unless opportunityId is set (ADR-009 §5).
    customerProfileId?: string;
    filename: string;
    declaredMimeType: string;
    buffer: Buffer;
    title?: string;
    description?: string;
    // Phase 4a — when set, customerProfileId is ALWAYS derived from the
    // opportunity, never the caller-supplied value.
    opportunityId?: string | null;
  },
  actor: Actor,
) {
  const validated = validateUpload({
    filename: input.filename,
    declaredMimeType: input.declaredMimeType,
    size: input.buffer.byteLength,
    buffer: input.buffer,
  });

  const customerProfileId = input.opportunityId
    ? await resolveCustomerProfileIdForOpportunity(input.opportunityId)
    : input.customerProfileId!;

  const storageKey = generateStorageKey(extensionOf(validated.sanitizedFilename));
  await uploadObject({ storageKey, body: input.buffer, mimeType: validated.mimeType });

  const file = await prisma.$transaction(async (tx) => {
    const created = await tx.file.create({
      data: {
        storageKey,
        originalFilename: validated.sanitizedFilename,
        mimeType: validated.mimeType,
        byteSize: input.buffer.byteLength,
        title: input.title,
        description: input.description,
        customerProfileId,
        opportunityId: input.opportunityId ?? null,
        uploadedById: actor.id,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });

    await tx.activity.create({
      data: {
        customerProfileId,
        type: "FILE_UPLOADED",
        sourceType: "CONTROL_CENTER",
        title: `Bestand geüpload: ${created.originalFilename}`,
        occurredAt: created.createdAt,
        actorId: actor.id,
        relatedFileId: created.id,
        relatedOpportunityId: created.opportunityId,
      },
    });

    return created;
  });

  await logAudit({
    userId: actor.id,
    action: "file.uploaded",
    entityType: "File",
    entityId: file.id,
    metadata: { originalFilename: file.originalFilename, mimeType: file.mimeType, byteSize: file.byteSize },
  });

  return file;
}

export async function getFileDownloadUrl(fileId: string) {
  const file = await prisma.file.findUniqueOrThrow({ where: { id: fileId } });
  if (file.deletedAt) throw new ForbiddenError("Dit bestand is verwijderd.");

  const isInlineSafe = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"].includes(file.mimeType);
  const url = await getSignedDownloadUrl({
    storageKey: file.storageKey,
    downloadFilename: sanitizeFilename(file.originalFilename),
    inline: isInlineSafe,
  });

  return { url, file };
}

export async function updateFileMetadata(fileId: string, input: { title?: string | null; description?: string | null }, actor: Actor) {
  const file = await prisma.file.findUniqueOrThrow({ where: { id: fileId } });
  assertCanDelete(file, actor); // same eligibility as delete: uploader or admin

  const updated = await prisma.file.update({ where: { id: fileId }, data: input });
  await logAudit({ userId: actor.id, action: "file.metadata_updated", entityType: "File", entityId: fileId });
  return updated;
}

/** Soft-deletes the metadata row (kept for audit/timeline consistency —
 * "bestand verwijderd" stays visible) and hard-deletes the R2 object
 * immediately (no orphaned storage). */
export async function deleteFile(fileId: string, actor: Actor) {
  const file = await prisma.file.findUniqueOrThrow({ where: { id: fileId } });
  assertCanDelete(file, actor);

  await deleteObject(file.storageKey);

  const deleted = await prisma.$transaction(async (tx) => {
    const result = await tx.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });

    if (result.customerProfileId) {
      await tx.activity.create({
        data: {
          customerProfileId: result.customerProfileId,
          type: "FILE_REMOVED",
          sourceType: "CONTROL_CENTER",
          title: `Bestand verwijderd: ${result.originalFilename}`,
          occurredAt: new Date(),
          actorId: actor.id,
          relatedFileId: result.id,
          relatedOpportunityId: result.opportunityId,
        },
      });
    }

    return result;
  });

  await logAudit({ userId: actor.id, action: "file.deleted", entityType: "File", entityId: fileId, metadata: { originalFilename: file.originalFilename } });
  return deleted;
}

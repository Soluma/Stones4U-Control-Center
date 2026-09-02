import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import type { Role } from "@/generated/prisma";

// Control Center CRM tags (docs/platform-discovery/26 §8) — distinct from,
// and never overwriting, any Shopify customer tag.

type Actor = { id: string; role: Role };

export async function listCustomerTags() {
  return prisma.customerTag.findMany({ orderBy: { name: "asc" } });
}

export async function createCustomerTag(input: { name: string; color?: string }, actor: Actor) {
  const tag = await prisma.customerTag.create({
    data: { name: input.name, color: input.color, createdById: actor.id },
  });
  await logAudit({ userId: actor.id, action: "customer_tag.created", entityType: "CustomerTag", entityId: tag.id, metadata: { name: tag.name } });
  return tag;
}

/** Deleting the tag type removes it (and, via cascade, every assignment)
 * everywhere it was used — ADMIN only, since this affects every customer
 * that currently has the tag, not just one (docs/platform-discovery/26 §7). */
export async function deleteCustomerTag(tagId: string, actor: Actor) {
  if (actor.role !== "ADMIN") {
    throw new ForbiddenError("Alleen een beheerder mag een tag-type verwijderen.");
  }
  const tag = await prisma.customerTag.delete({ where: { id: tagId } });
  await logAudit({ userId: actor.id, action: "customer_tag.deleted", entityType: "CustomerTag", entityId: tagId, metadata: { name: tag.name } });
  return tag;
}

export async function assignTagToCustomer(customerProfileId: string, tagId: string, actor: Actor) {
  const assignment = await prisma.customerTagAssignment.upsert({
    where: { customerProfileId_tagId: { customerProfileId, tagId } },
    create: { customerProfileId, tagId, assignedById: actor.id },
    update: {},
    include: { tag: true },
  });
  await logAudit({
    userId: actor.id,
    action: "customer_tag.assigned",
    entityType: "CustomerTag",
    entityId: tagId,
    metadata: { customerProfileId },
  });
  return assignment;
}

export async function unassignTagFromCustomer(customerProfileId: string, tagId: string, actor: Actor) {
  await prisma.customerTagAssignment.delete({
    where: { customerProfileId_tagId: { customerProfileId, tagId } },
  });
  await logAudit({
    userId: actor.id,
    action: "customer_tag.unassigned",
    entityType: "CustomerTag",
    entityId: tagId,
    metadata: { customerProfileId },
  });
}

export async function listTagsForCustomer(customerProfileId: string) {
  const assignments = await prisma.customerTagAssignment.findMany({
    where: { customerProfileId },
    include: { tag: true },
    orderBy: { tag: { name: "asc" } },
  });
  return assignments.map((a) => a.tag);
}

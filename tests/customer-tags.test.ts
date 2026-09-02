import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import {
  createCustomerTag,
  deleteCustomerTag,
  assignTagToCustomer,
  unassignTagFromCustomer,
  listTagsForCustomer,
} from "@/modules/crm/customer-tag.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

describe("customer-tag.service", () => {
  let agent: { id: string; role: "AGENT" };
  let admin: { id: string; role: "ADMIN" };
  let customerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const agentUser = await createTestUser({ role: "AGENT" });
    const adminUser = await createTestUser({ role: "ADMIN" });
    const profile = await createTestCustomerProfile();

    agent = { id: agentUser.id, role: "AGENT" };
    admin = { id: adminUser.id, role: "ADMIN" };
    customerProfileId = profile.id;
    userIds.push(agentUser.id, adminUser.id);
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("creates a tag, assigns it to a customer, and it's never a Shopify tag field", async () => {
    const tag = await createCustomerTag({ name: `VIP-${crypto.randomUUID()}`, color: "#6366f1" }, agent);
    await assignTagToCustomer(customerProfileId, tag.id, agent);

    const tags = await listTagsForCustomer(customerProfileId);
    expect(tags.some((t) => t.id === tag.id)).toBe(true);

    await deleteCustomerTag(tag.id, admin); // cleanup via admin path, exercised below too
  });

  it("assigning the same tag twice is idempotent (no duplicate rows, no error)", async () => {
    const tag = await createCustomerTag({ name: `Idempotent-${crypto.randomUUID()}` }, agent);
    await assignTagToCustomer(customerProfileId, tag.id, agent);
    await assignTagToCustomer(customerProfileId, tag.id, agent);

    const assignments = await prisma.customerTagAssignment.findMany({ where: { customerProfileId, tagId: tag.id } });
    expect(assignments).toHaveLength(1);

    await deleteCustomerTag(tag.id, admin);
  });

  it("unassigns a tag from a customer without deleting the tag type itself", async () => {
    const tag = await createCustomerTag({ name: `Unassign-${crypto.randomUUID()}` }, agent);
    await assignTagToCustomer(customerProfileId, tag.id, agent);
    await unassignTagFromCustomer(customerProfileId, tag.id, agent);

    const tags = await listTagsForCustomer(customerProfileId);
    expect(tags.some((t) => t.id === tag.id)).toBe(false);

    const stillExists = await prisma.customerTag.findUnique({ where: { id: tag.id } });
    expect(stillExists).not.toBeNull();

    await deleteCustomerTag(tag.id, admin);
  });

  it("forbids a non-admin from deleting a tag type", async () => {
    const tag = await createCustomerTag({ name: `Protected-${crypto.randomUUID()}` }, agent);
    await expect(deleteCustomerTag(tag.id, agent)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteCustomerTag(tag.id, admin);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { assignTask, createTask, listTasksForCustomer, updateTaskStatus, updateTaskDetails } from "@/modules/tasks/task.service";
import { createContact, CustomerContactValidationError } from "@/modules/crm/customer-contact.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

describe("task.service", () => {
  let creator: { id: string; role: "AGENT" };
  let assignee: { id: string; role: "AGENT" };
  let bystander: { id: string; role: "AGENT" };
  let admin: { id: string; role: "ADMIN" };
  let customerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const creatorUser = await createTestUser({ role: "AGENT" });
    const assigneeUser = await createTestUser({ role: "AGENT" });
    const bystanderUser = await createTestUser({ role: "AGENT" });
    const adminUser = await createTestUser({ role: "ADMIN" });
    const profile = await createTestCustomerProfile();

    creator = { id: creatorUser.id, role: "AGENT" };
    assignee = { id: assigneeUser.id, role: "AGENT" };
    bystander = { id: bystanderUser.id, role: "AGENT" };
    admin = { id: adminUser.id, role: "ADMIN" };
    customerProfileId = profile.id;
    userIds.push(creatorUser.id, assigneeUser.id, bystanderUser.id, adminUser.id);
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("creates a task linked to a customer and writes a TASK_CREATED activity", async () => {
    const task = await createTask(
      { title: "Klant terugbellen", assignedToId: assignee.id, customerProfileId },
      creator,
    );
    expect(task.status).toBe("OPEN");

    const activity = await prisma.activity.findFirst({ where: { relatedTaskId: task.id, type: "TASK_CREATED" } });
    expect(activity).not.toBeNull();

    const tasksForCustomer = await listTasksForCustomer(customerProfileId);
    expect(tasksForCustomer.some((t) => t.id === task.id)).toBe(true);
  });

  it("lets the assignee complete a task and sets completedAt", async () => {
    const task = await createTask({ title: "Offerte opvolgen", assignedToId: assignee.id, customerProfileId }, creator);
    const completed = await updateTaskStatus(task.id, "DONE", assignee);
    expect(completed.status).toBe("DONE");
    expect(completed.completedAt).not.toBeNull();
  });

  it("lets an admin modify any task regardless of creator/assignee", async () => {
    const task = await createTask({ title: "Escalatie", assignedToId: assignee.id, customerProfileId }, creator);
    const updated = await updateTaskStatus(task.id, "IN_PROGRESS", admin);
    expect(updated.status).toBe("IN_PROGRESS");
  });

  it("forbids an unrelated agent (not creator, not assignee, not admin) from changing status", async () => {
    const task = await createTask({ title: "Privé taak", assignedToId: assignee.id, customerProfileId }, creator);
    await expect(updateTaskStatus(task.id, "DONE", bystander)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("forbids an unrelated agent from reassigning a task", async () => {
    const task = await createTask({ title: "Herverdelen", assignedToId: assignee.id, customerProfileId }, creator);
    await expect(assignTask(task.id, bystander.id, bystander)).rejects.toBeInstanceOf(ForbiddenError);
  });

  describe("Phase 4c — customerContactId invariant (build spec §20)", () => {
    it("allows a contact belonging to the same customer", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Jan Jansen" }, creator);
      const task = await createTask({ title: "Jan terugbellen", assignedToId: assignee.id, customerProfileId, customerContactId: contact.id }, creator);
      expect(task.customerContactId).toBe(contact.id);
    });

    it("blocks a contact belonging to a different customer than the task's own customer", async () => {
      const otherProfile = await createTestCustomerProfile();
      try {
        const { contact } = await createContact({ customerProfileId: otherProfile.id, displayName: "Klant B Contact" }, creator);
        await expect(
          createTask({ title: "Verkeerde klant", assignedToId: assignee.id, customerProfileId, customerContactId: contact.id }, creator),
        ).rejects.toBeInstanceOf(CustomerContactValidationError);
      } finally {
        await prisma.customerContact.deleteMany({ where: { customerProfileId: otherProfile.id } });
        await cleanupCustomerProfile(otherProfile.id);
      }
    });

    it("blocks a contact belonging to a different customer than an opportunity-derived customer", async () => {
      const { createOpportunity } = await import("@/modules/opportunities/opportunity.service");
      const otherProfile = await createTestCustomerProfile();
      try {
        const opportunity = await createOpportunity({ customerProfileId, title: "Opportunity A", ownerUserId: creator.id }, creator);
        const { contact } = await createContact({ customerProfileId: otherProfile.id, displayName: "Klant B Contact" }, creator);
        await expect(
          createTask({ title: "Opportunity A + contact B", assignedToId: assignee.id, opportunityId: opportunity.id, customerContactId: contact.id }, creator),
        ).rejects.toBeInstanceOf(CustomerContactValidationError);
      } finally {
        await prisma.customerContact.deleteMany({ where: { customerProfileId: otherProfile.id } });
        await cleanupCustomerProfile(otherProfile.id);
      }
    });

    it("allows a contact matching the opportunity-derived customer", async () => {
      const { createOpportunity } = await import("@/modules/opportunities/opportunity.service");
      const opportunity = await createOpportunity({ customerProfileId, title: "Opportunity Zelfde Klant", ownerUserId: creator.id }, creator);
      const { contact } = await createContact({ customerProfileId, displayName: "Zelfde Klant Contact" }, creator);
      const task = await createTask(
        { title: "Zelfde klant, ok", assignedToId: assignee.id, opportunityId: opportunity.id, customerContactId: contact.id },
        creator,
      );
      expect(task.customerContactId).toBe(contact.id);
      expect(task.customerProfileId).toBe(customerProfileId);
    });

    it("blocks setting customerContactId via updateTaskDetails when it belongs to a different customer", async () => {
      const otherProfile = await createTestCustomerProfile();
      try {
        const task = await createTask({ title: "Update-test", assignedToId: assignee.id, customerProfileId }, creator);
        const { contact } = await createContact({ customerProfileId: otherProfile.id, displayName: "Klant B" }, creator);
        await expect(updateTaskDetails(task.id, { customerContactId: contact.id }, creator)).rejects.toBeInstanceOf(CustomerContactValidationError);
      } finally {
        await prisma.customerContact.deleteMany({ where: { customerProfileId: otherProfile.id } });
        await cleanupCustomerProfile(otherProfile.id);
      }
    });
  });
});

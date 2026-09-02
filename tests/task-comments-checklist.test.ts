import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import {
  createTask,
  addTaskComment,
  addChecklistItem,
  toggleChecklistItem,
  removeChecklistItem,
  getTaskDetail,
  searchTasks,
  updateTaskDetails,
} from "@/modules/tasks/task.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

describe("task.service — Phase 2 (comments, checklist, search, updates)", () => {
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

  it("adds a comment and writes a TASK_COMMENT_ADDED activity", async () => {
    const task = await createTask({ title: "Met opmerking", assignedToId: assignee.id, customerProfileId }, creator);
    const comment = await addTaskComment(task.id, "Klant gebeld, wacht op reactie.", assignee);
    expect(comment.body).toContain("Klant gebeld");

    const activity = await prisma.activity.findFirst({ where: { relatedTaskId: task.id, type: "TASK_COMMENT_ADDED" } });
    expect(activity).not.toBeNull();

    const detail = await getTaskDetail(task.id);
    expect(detail.comments).toHaveLength(1);
  });

  it("forbids an unrelated agent from commenting", async () => {
    const task = await createTask({ title: "Privé", assignedToId: assignee.id, customerProfileId }, creator);
    await expect(addTaskComment(task.id, "Ongewenst", bystander)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("manages a checklist: add, toggle, remove — no Activity per toggle, but one when the list is fully completed", async () => {
    const task = await createTask({ title: "Met checklist", assignedToId: assignee.id, customerProfileId }, creator);
    const item1 = await addChecklistItem(task.id, "Stap 1", assignee);
    const item2 = await addChecklistItem(task.id, "Stap 2", assignee);

    await toggleChecklistItem(task.id, item1.id, true, assignee);
    let completedActivity = await prisma.activity.findFirst({ where: { relatedTaskId: task.id, type: "TASK_CHECKLIST_COMPLETED" } });
    expect(completedActivity).toBeNull(); // one item still open — must not fire yet

    await toggleChecklistItem(task.id, item2.id, true, assignee);
    completedActivity = await prisma.activity.findFirst({ where: { relatedTaskId: task.id, type: "TASK_CHECKLIST_COMPLETED" } });
    expect(completedActivity).not.toBeNull(); // last item done -> fires exactly once

    await removeChecklistItem(task.id, item2.id, assignee);
    const detail = await getTaskDetail(task.id);
    expect(detail.checklistItems).toHaveLength(1);
  });

  it("forbids an unrelated agent from managing the checklist", async () => {
    const task = await createTask({ title: "Checklist privé", assignedToId: assignee.id, customerProfileId }, creator);
    await expect(addChecklistItem(task.id, "Item", bystander)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("updates task details (title/priority/tags) and writes a TASK_UPDATED activity", async () => {
    const task = await createTask({ title: "Origineel", assignedToId: assignee.id, customerProfileId }, creator);
    const updated = await updateTaskDetails(task.id, { title: "Bijgewerkt", priority: "URGENT", tags: ["spoed"] }, assignee);
    expect(updated.title).toBe("Bijgewerkt");
    expect(updated.priority).toBe("URGENT");
    expect(updated.tags).toEqual(["spoed"]);

    const activity = await prisma.activity.findFirst({ where: { relatedTaskId: task.id, type: "TASK_UPDATED" } });
    expect(activity).not.toBeNull();
  });

  it("a pre-existing Phase-1-shaped task (no tags/checklist/comments) still round-trips through getTaskDetail", async () => {
    const task = await createTask({ title: "Klassieke taak", assignedToId: assignee.id, customerProfileId }, creator);
    const detail = await getTaskDetail(task.id);
    expect(detail.tags).toEqual([]);
    expect(detail.checklistItems).toEqual([]);
    expect(detail.comments).toEqual([]);
  });

  it("searchTasks finds by title, admin sees all, agent only sees own", async () => {
    const uniqueTitle = `Zoekbare taak ${crypto.randomUUID()}`;
    await createTask({ title: uniqueTitle, assignedToId: assignee.id, customerProfileId }, creator);

    const asAdmin = await searchTasks(admin, uniqueTitle);
    expect(asAdmin.some((t) => t.title === uniqueTitle)).toBe(true);

    const asAssignee = await searchTasks(assignee, uniqueTitle);
    expect(asAssignee.some((t) => t.title === uniqueTitle)).toBe(true);

    const asBystander = await searchTasks(bystander, uniqueTitle);
    expect(asBystander.some((t) => t.title === uniqueTitle)).toBe(false);
  });
});

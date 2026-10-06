import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { countOpenTasksAssignedTo, createTask, getTaskSummary, searchTasks, updateTaskStatus } from "@/modules/tasks/task.service";
import { OPEN_TASK_STATUSES, taskBadgeLabel } from "@/modules/tasks/task-status";
import { matchesTaskQuery } from "@/app/(app)/tasks/TasksList";
import { TASK_DESCRIPTION_MAX, taskDescriptionSchema } from "@/modules/tasks/task-input";
import { createTestUser, cleanupUser } from "./fixtures";

describe("taskBadgeLabel", () => {
  it("shows nothing at 0, the number from 1 to 99 and 99+ above", () => {
    expect(taskBadgeLabel(0)).toBeNull();
    expect(taskBadgeLabel(-1)).toBeNull();
    expect(taskBadgeLabel(Number.NaN)).toBeNull();
    expect(taskBadgeLabel(1)).toBe("1");
    expect(taskBadgeLabel(3)).toBe("3");
    expect(taskBadgeLabel(99)).toBe("99");
    expect(taskBadgeLabel(100)).toBe("99+");
    expect(taskBadgeLabel(2500)).toBe("99+");
  });

  it("counts exactly the open statuses", () => {
    expect([...OPEN_TASK_STATUSES].sort()).toEqual(["IN_PROGRESS", "OPEN", "WAITING"]);
  });
});

describe("taskDescriptionSchema", () => {
  it("accepts up to 5000 characters including line breaks and rejects 5001", () => {
    expect(TASK_DESCRIPTION_MAX).toBe(5000);
    expect(taskDescriptionSchema.safeParse("a\n".repeat(2500)).success).toBe(true);
    expect(taskDescriptionSchema.safeParse("x".repeat(5000)).success).toBe(true);
    expect(taskDescriptionSchema.safeParse("x".repeat(5001)).success).toBe(false);
    expect(taskDescriptionSchema.optional().safeParse(undefined).success).toBe(true);
  });
});

describe("matchesTaskQuery (client search on /tasks)", () => {
  const task = { title: "Klant terugbellen", description: "Afgesproken:\nlevering op palletplaats achter de schuur" };

  it("matches title or description, case-insensitive", () => {
    expect(matchesTaskQuery(task, "terugbellen")).toBe(true);
    expect(matchesTaskQuery(task, "SCHUUR")).toBe(true);
    expect(matchesTaskQuery(task, "  palletplaats ")).toBe(true);
    expect(matchesTaskQuery(task, "factuur")).toBe(false);
  });

  it("treats an empty query as no filter and copes with a missing description", () => {
    expect(matchesTaskQuery(task, "")).toBe(true);
    expect(matchesTaskQuery({ title: "Alleen titel", description: null }, "schuur")).toBe(false);
  });
});

describe("open-task badge count, task description and search (DB)", () => {
  let admin: { id: string; role: "ADMIN" };
  let agent: { id: string; role: "AGENT" };
  let other: { id: string; role: "AGENT" };
  const userIds: string[] = [];
  const marker = `UXTEST-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const a = await createTestUser({ role: "ADMIN" });
    const b = await createTestUser({ role: "AGENT" });
    const c = await createTestUser({ role: "AGENT" });
    admin = { id: a.id, role: "ADMIN" };
    agent = { id: b.id, role: "AGENT" };
    other = { id: c.id, role: "AGENT" };
    userIds.push(a.id, b.id, c.id);
  });

  afterAll(async () => {
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("is 0 for a user without tasks", async () => {
    expect(await countOpenTasksAssignedTo(agent.id)).toBe(0);
  });

  it("counts OPEN, IN_PROGRESS and WAITING assigned to me, never DONE/CANCELLED or tasks I only created", async () => {
    const t1 = await createTask({ title: `${marker} open`, assignedToId: agent.id }, admin);
    const t2 = await createTask({ title: `${marker} bezig`, assignedToId: agent.id }, admin);
    const t3 = await createTask({ title: `${marker} wacht`, assignedToId: agent.id }, admin);
    await updateTaskStatus(t2.id, "IN_PROGRESS", agent);
    await updateTaskStatus(t3.id, "WAITING", agent);
    const done = await createTask({ title: `${marker} klaar`, assignedToId: agent.id }, admin);
    await updateTaskStatus(done.id, "DONE", agent);
    const cancelled = await createTask({ title: `${marker} geannuleerd`, assignedToId: agent.id }, admin);
    await updateTaskStatus(cancelled.id, "CANCELLED", agent);
    // Created by the agent but assigned to someone else: not in the agent's badge.
    await createTask({ title: `${marker} voor collega`, assignedToId: other.id }, agent);

    expect(t1.status).toBe("OPEN");
    expect(await countOpenTasksAssignedTo(agent.id)).toBe(3);
    expect(await countOpenTasksAssignedTo(other.id)).toBe(1);
    // Same definition as the dashboard total "Aan mij toegewezen".
    expect((await getTaskSummary(agent)).assignedToMe).toBe(3);
  });

  it("counts only an ADMIN's own tasks, not the whole team", async () => {
    expect(await countOpenTasksAssignedTo(admin.id)).toBe(0);
    await createTask({ title: `${marker} admin eigen`, assignedToId: admin.id }, agent);
    expect(await countOpenTasksAssignedTo(admin.id)).toBe(1);
  });

  it("goes above 99 without a cap in the count itself (label shows 99+)", async () => {
    await prisma.task.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({ title: `${marker} bulk ${i}`, assignedToId: other.id, createdById: other.id })),
    });
    const count = await countOpenTasksAssignedTo(other.id);
    expect(count).toBe(101);
    expect(taskBadgeLabel(count)).toBe("99+");
  });

  it("stores a multi-line description exactly as typed, up to 5000 characters", async () => {
    const description = `Eerste alinea over de levering.\n\nTweede alinea:\n- pallet 1\n- pallet 2\n\n  Ingesprongen regel ${marker}`;
    const task = await createTask({ title: `${marker} omschrijving`, description, assignedToId: agent.id }, agent);
    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.description).toBe(description);

    const long = "x".repeat(4999) + "\n";
    const longTask = await createTask({ title: `${marker} lang`, description: long, assignedToId: agent.id }, agent);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: longTask.id } })).description).toHaveLength(5000);
  });

  it("searchTasks finds a match in the description, with unchanged scoping", async () => {
    const needle = `zoekwoord${marker.slice(-8)}`;
    const mine = await createTask({ title: `${marker} titel zonder woord`, description: `regel 1\nhier staat ${needle}`, assignedToId: agent.id }, agent);
    const foreign = await createTask({ title: `${marker} andermans taak`, description: `ook ${needle}`, assignedToId: other.id }, other);

    const agentHits = (await searchTasks(agent, needle)).map((t) => t.id);
    expect(agentHits).toContain(mine.id);
    expect(agentHits).not.toContain(foreign.id);

    const adminHits = (await searchTasks(admin, needle)).map((t) => t.id);
    expect(adminHits).toEqual(expect.arrayContaining([mine.id, foreign.id]));

    // Title search still works.
    expect((await searchTasks(agent, `${marker} titel zonder`)).map((t) => t.id)).toContain(mine.id);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { getMyWorkTasks, getMyWorkAppointments, getMyWorkOpportunityAttention } from "@/modules/dashboard/my-work";
import { createTask, updateTaskStatus } from "@/modules/tasks/task.service";
import { createAppointment } from "@/modules/appointments/appointment.service";
import { createOpportunity } from "@/modules/opportunities/opportunity.service";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

// Phase 6A — "Mijn Werk" (docs/build/PHASE-6A-MY-WORK-STAGING.md). Every
// scenario is scoped to its own dedicated actor pair so results can never be
// polluted by other tests' fixture data running against the same database.

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

describe("getMyWorkTasks", () => {
  let actorA: { id: string; role: "AGENT" };
  let actorB: { id: string; role: "AGENT" };
  let admin: { id: string; role: "ADMIN" };
  let customerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const userA = await createTestUser({ role: "AGENT" });
    const userB = await createTestUser({ role: "AGENT" });
    const adminUser = await createTestUser({ role: "ADMIN" });
    actorA = { id: userA.id, role: "AGENT" };
    actorB = { id: userB.id, role: "AGENT" };
    admin = { id: adminUser.id, role: "ADMIN" };
    userIds.push(userA.id, userB.id, adminUser.id);
    const profile = await createTestCustomerProfile();
    customerProfileId = profile.id;
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("includes an overdue task assigned to the actor, classified OVERDUE", async () => {
    const task = await createTask({ title: "Gisteren vervallen", assignedToId: actorA.id, customerProfileId, dueAt: daysFromNow(-1) }, actorA);
    const result = await getMyWorkTasks(actorA);
    const found = result.find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found!.urgency).toBe("OVERDUE");
  });

  it("includes a task due today, classified DUE_TODAY", async () => {
    const todayNoon = new Date();
    todayNoon.setHours(12, 0, 0, 0);
    const task = await createTask({ title: "Vandaag om 12u", assignedToId: actorA.id, customerProfileId, dueAt: todayNoon }, actorA);
    const result = await getMyWorkTasks(actorA);
    const found = result.find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found!.urgency).toBe("DUE_TODAY");
  });

  it("excludes a task assigned to a different actor", async () => {
    const task = await createTask({ title: "Van actor B", assignedToId: actorB.id, customerProfileId, dueAt: daysFromNow(-1) }, actorB);
    const result = await getMyWorkTasks(actorA);
    expect(result.some((t) => t.id === task.id)).toBe(false);
  });

  it("excludes a completed (DONE) task even if overdue", async () => {
    const task = await createTask({ title: "Afgerond maar te laat", assignedToId: actorA.id, customerProfileId, dueAt: daysFromNow(-2) }, actorA);
    await updateTaskStatus(task.id, "DONE", actorA);
    const result = await getMyWorkTasks(actorA);
    expect(result.some((t) => t.id === task.id)).toBe(false);
  });

  it("excludes a future task (due tomorrow or later)", async () => {
    const task = await createTask({ title: "Morgen pas", assignedToId: actorA.id, customerProfileId, dueAt: daysFromNow(1) }, actorA);
    const result = await getMyWorkTasks(actorA);
    expect(result.some((t) => t.id === task.id)).toBe(false);
  });

  it("excludes a task with no due date at all (build spec never defines these as actionable here)", async () => {
    const task = await createTask({ title: "Geen deadline", assignedToId: actorA.id, customerProfileId }, actorA);
    const result = await getMyWorkTasks(actorA);
    expect(result.some((t) => t.id === task.id)).toBe(false);
  });

  it("orders most-urgent-first: older overdue before newer overdue, before due-today", async () => {
    const actorC = await createTestUser({ role: "AGENT" });
    userIds.push(actorC.id);
    const actor = { id: actorC.id, role: "AGENT" as const };

    const todayNoon = new Date();
    todayNoon.setHours(12, 0, 0, 0);
    const dueToday = await createTask({ title: "Vandaag", assignedToId: actor.id, customerProfileId, dueAt: todayNoon }, actor);
    const overdueRecent = await createTask({ title: "1 dag te laat", assignedToId: actor.id, customerProfileId, dueAt: daysFromNow(-1) }, actor);
    const overdueOld = await createTask({ title: "5 dagen te laat", assignedToId: actor.id, customerProfileId, dueAt: daysFromNow(-5) }, actor);

    const result = await getMyWorkTasks(actor);
    expect(result.map((t) => t.id)).toEqual([overdueOld.id, overdueRecent.id, dueToday.id]);
  });

  it("caps at 10 items even when more are actionable", async () => {
    const actorD = await createTestUser({ role: "AGENT" });
    userIds.push(actorD.id);
    const actor = { id: actorD.id, role: "AGENT" as const };

    for (let i = 0; i < 12; i++) {
      await createTask({ title: `Taak ${i}`, assignedToId: actor.id, customerProfileId, dueAt: daysFromNow(-1 - i) }, actor);
    }
    const result = await getMyWorkTasks(actor);
    expect(result).toHaveLength(10);
    // Most overdue (oldest dueAt) must be first among the capped set.
    expect(result[0]!.title).toBe("Taak 11");
  });

  it("ADMIN still only sees tasks assigned to themself, never a team-wide view", async () => {
    const task = await createTask({ title: "Voor actor A, niet voor admin", assignedToId: actorA.id, customerProfileId, dueAt: daysFromNow(-1) }, actorA);
    const adminOwnTask = await createTask({ title: "Voor admin zelf", assignedToId: admin.id, customerProfileId, dueAt: daysFromNow(-1) }, admin);

    const result = await getMyWorkTasks(admin);
    expect(result.some((t) => t.id === task.id)).toBe(false);
    expect(result.some((t) => t.id === adminOwnTask.id)).toBe(true);
  });

  it("returns null customerProfile for a standalone task with no customer link", async () => {
    const task = await createTask({ title: "Zonder klant", assignedToId: actorA.id, dueAt: daysFromNow(-1) }, actorA);
    const result = await getMyWorkTasks(actorA);
    const found = result.find((t) => t.id === task.id);
    expect(found?.customerProfile).toBeNull();
  });
});

describe("getMyWorkAppointments", () => {
  let actorA: { id: string; role: "AGENT" };
  let actorB: { id: string; role: "AGENT" };
  let customerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const userA = await createTestUser({ role: "AGENT" });
    const userB = await createTestUser({ role: "AGENT" });
    actorA = { id: userA.id, role: "AGENT" };
    actorB = { id: userB.id, role: "AGENT" };
    userIds.push(userA.id, userB.id);
    const profile = await createTestCustomerProfile();
    customerProfileId = profile.id;
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("includes an appointment scheduled for today", async () => {
    const todayNoon = new Date();
    todayNoon.setHours(12, 0, 0, 0);
    const appointment = await createAppointment({ title: "Vandaag om 12u", customerProfileId, assignedToId: actorA.id, startsAt: todayNoon }, actorA);
    const result = await getMyWorkAppointments(actorA);
    expect(result.some((a) => a.id === appointment.id)).toBe(true);
  });

  it("excludes an appointment from yesterday", async () => {
    const appointment = await createAppointment({ title: "Gisteren", customerProfileId, assignedToId: actorA.id, startsAt: daysFromNow(-1) }, actorA);
    const result = await getMyWorkAppointments(actorA);
    expect(result.some((a) => a.id === appointment.id)).toBe(false);
  });

  it("excludes an appointment tomorrow (no fallback beyond today — build spec defines only 'vandaag')", async () => {
    const appointment = await createAppointment({ title: "Morgen", customerProfileId, assignedToId: actorA.id, startsAt: daysFromNow(1) }, actorA);
    const result = await getMyWorkAppointments(actorA);
    expect(result.some((a) => a.id === appointment.id)).toBe(false);
  });

  it("excludes an appointment assigned to a different actor", async () => {
    const todayNoon = new Date();
    todayNoon.setHours(15, 0, 0, 0);
    const appointment = await createAppointment({ title: "Van actor B", customerProfileId, assignedToId: actorB.id, startsAt: todayNoon }, actorB);
    const result = await getMyWorkAppointments(actorA);
    expect(result.some((a) => a.id === appointment.id)).toBe(false);
  });

  it("respects the exact day boundary — 23:59 today included, 00:01 tomorrow excluded", async () => {
    const actorE = await createTestUser({ role: "AGENT" });
    userIds.push(actorE.id);
    const actor = { id: actorE.id, role: "AGENT" as const };

    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 0, 0);
    const startOfTomorrow = new Date(endOfToday);
    startOfTomorrow.setHours(24, 1, 0, 0);

    const lateToday = await createAppointment({ title: "23:59 vandaag", customerProfileId, assignedToId: actor.id, startsAt: endOfToday }, actor);
    const earlyTomorrow = await createAppointment({ title: "00:01 morgen", customerProfileId, assignedToId: actor.id, startsAt: startOfTomorrow }, actor);

    const result = await getMyWorkAppointments(actor);
    expect(result.some((a) => a.id === lateToday.id)).toBe(true);
    expect(result.some((a) => a.id === earlyTomorrow.id)).toBe(false);
  });

  it("orders chronologically ascending", async () => {
    const actorF = await createTestUser({ role: "AGENT" });
    userIds.push(actorF.id);
    const actor = { id: actorF.id, role: "AGENT" as const };

    const early = new Date();
    early.setHours(9, 0, 0, 0);
    const late = new Date();
    late.setHours(17, 0, 0, 0);

    const lateAppt = await createAppointment({ title: "17u", customerProfileId, assignedToId: actor.id, startsAt: late }, actor);
    const earlyAppt = await createAppointment({ title: "9u", customerProfileId, assignedToId: actor.id, startsAt: early }, actor);

    const result = await getMyWorkAppointments(actor);
    expect(result.map((a) => a.id)).toEqual([earlyAppt.id, lateAppt.id]);
  });

  it("caps at 10 items", async () => {
    const actorG = await createTestUser({ role: "AGENT" });
    userIds.push(actorG.id);
    const actor = { id: actorG.id, role: "AGENT" as const };

    for (let i = 0; i < 12; i++) {
      const at = new Date();
      at.setHours(8 + i, 0, 0, 0);
      await createAppointment({ title: `Afspraak ${i}`, customerProfileId, assignedToId: actor.id, startsAt: at }, actor);
    }
    const result = await getMyWorkAppointments(actor);
    expect(result).toHaveLength(10);
  });

  it("returns an empty array when there are no appointments today", async () => {
    const actorH = await createTestUser({ role: "AGENT" });
    userIds.push(actorH.id);
    const result = await getMyWorkAppointments({ id: actorH.id, role: "AGENT" });
    expect(result).toEqual([]);
  });
});

describe("getMyWorkOpportunityAttention", () => {
  let actorA: { id: string; role: "AGENT" };
  let actorB: { id: string; role: "AGENT" };
  let customerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const userA = await createTestUser({ role: "AGENT" });
    const userB = await createTestUser({ role: "AGENT" });
    actorA = { id: userA.id, role: "AGENT" };
    actorB = { id: userB.id, role: "AGENT" };
    userIds.push(userA.id, userB.id);
    const profile = await createTestCustomerProfile();
    customerProfileId = profile.id;
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("includes a RED opportunity (overdue next-action task)", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "RED-kans", ownerUserId: actorA.id }, actorA);
    await createTask({ title: "Achterstallig", assignedToId: actorA.id, opportunityId: opportunity.id, dueAt: daysFromNow(-3) }, actorA);

    const result = await getMyWorkOpportunityAttention(actorA);
    const found = result.find((o) => o.id === opportunity.id);
    expect(found).toBeDefined();
    expect(found!.attention.severity).toBe("RED");
  });

  it("includes an ORANGE opportunity (no next action scheduled)", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "ORANGE-kans", ownerUserId: actorA.id }, actorA);
    // No task at all -> NO_NEXT_ACTION -> ORANGE (same fixture pattern as
    // opportunity-dashboard.test.ts's attentionCount scenario).
    const result = await getMyWorkOpportunityAttention(actorA);
    const found = result.find((o) => o.id === opportunity.id);
    expect(found).toBeDefined();
    expect(found!.attention.severity).toBe("ORANGE");
  });

  // BLUE (SHOPIFY_ORDER_PLACED / QUOTE_AHEAD_OF_STAGE) is never reachable via
  // this path — and this is correct, not a gap. Both signals require a
  // per-opportunity live Shopify/quote fetch that only the opportunity detail
  // page performs (opportunity.service.ts's attachAttention() never passes
  // them — see its own doc comment); listOpportunities() (which this module
  // reuses unchanged) has never surfaced BLUE, including on the existing
  // pipeline board. Building a BLUE path here would require a per-card
  // external call, which build instruction §10 explicitly forbids. Sorting
  // by severity is still exercised below with RED/ORANGE, which is the only
  // combination this function can ever actually produce.
  it("sorts RED before ORANGE when both are present", async () => {
    const actorI = await createTestUser({ role: "AGENT" });
    userIds.push(actorI.id);
    const actor = { id: actorI.id, role: "AGENT" as const };

    const orange = await createOpportunity({ customerProfileId, title: "ORANGE", ownerUserId: actor.id }, actor);
    const red = await createOpportunity({ customerProfileId, title: "RED", ownerUserId: actor.id }, actor);
    await createTask({ title: "Te laat", assignedToId: actor.id, opportunityId: red.id, dueAt: daysFromNow(-1) }, actor);

    const result = await getMyWorkOpportunityAttention(actor);
    const ids = result.map((o) => o.id);
    expect(ids.indexOf(red.id)).toBeLessThan(ids.indexOf(orange.id));
  });

  it("excludes an opportunity with no attention reason (has a scheduled future next action)", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Alles op orde", ownerUserId: actorA.id }, actorA);
    await createTask({ title: "Gepland", assignedToId: actorA.id, opportunityId: opportunity.id, dueAt: daysFromNow(3) }, actorA);
    const result = await getMyWorkOpportunityAttention(actorA);
    expect(result.some((o) => o.id === opportunity.id)).toBe(false);
  });

  it("excludes opportunities owned by a different actor", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Van actor B", ownerUserId: actorB.id }, actorB);
    const result = await getMyWorkOpportunityAttention(actorA);
    expect(result.some((o) => o.id === opportunity.id)).toBe(false);
  });

  it("caps at 10 items", async () => {
    const actorJ = await createTestUser({ role: "AGENT" });
    userIds.push(actorJ.id);
    const actor = { id: actorJ.id, role: "AGENT" as const };

    for (let i = 0; i < 12; i++) {
      await createOpportunity({ customerProfileId, title: `Kans ${i}`, ownerUserId: actor.id }, actor);
    }
    const result = await getMyWorkOpportunityAttention(actor);
    expect(result).toHaveLength(10);
  });
});

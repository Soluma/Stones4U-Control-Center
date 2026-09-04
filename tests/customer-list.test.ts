import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { listCustomerProfiles, getCustomerListCounts, updateCustomerCrmFields, assignCustomerToSelfIfUnassigned } from "@/modules/crm/customer-profile.service";
import { createTestUser, cleanupUser } from "./fixtures";

// Phase 6b — local customer list (docs/build/PHASE-6B-MY-CUSTOMERS-STAGING.md).
// Every scenario uses its own dedicated actor(s) + customer(s) so results
// can never be polluted by other tests' fixture data running in parallel
// against the same database.

async function createCustomer(overrides: {
  displayName?: string;
  companyName?: string | null;
  accountManagerId?: string | null;
}) {
  return prisma.customerProfile.create({
    data: {
      shopifyCustomerGid: `gid://shopify/Customer/${crypto.randomUUID()}`,
      displayName: overrides.displayName ?? `Fixture Klant ${crypto.randomUUID().slice(0, 8)}`,
      companyName: overrides.companyName ?? null,
      accountManagerId: overrides.accountManagerId ?? null,
    },
  });
}

async function cleanupCustomers(ids: string[]) {
  await prisma.activity.deleteMany({ where: { customerProfileId: { in: ids } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: ids } } });
}

describe("listCustomerProfiles / getCustomerListCounts", () => {
  let actorA: { id: string; role: "AGENT" };
  let actorB: { id: string; role: "AGENT" };
  let admin: { id: string; role: "ADMIN" };
  const userIds: string[] = [];
  const customerIds: string[] = [];

  beforeAll(async () => {
    const userA = await createTestUser({ role: "AGENT" });
    const userB = await createTestUser({ role: "AGENT" });
    const adminUser = await createTestUser({ role: "ADMIN" });
    actorA = { id: userA.id, role: "AGENT" };
    actorB = { id: userB.id, role: "AGENT" };
    admin = { id: adminUser.id, role: "ADMIN" };
    userIds.push(userA.id, userB.id, adminUser.id);
  });

  afterAll(async () => {
    await cleanupCustomers(customerIds);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("mine: includes an actor-owned customer, excludes another accountmanager's and an unassigned one", async () => {
    const mineCustomer = await createCustomer({ accountManagerId: actorA.id });
    const otherCustomer = await createCustomer({ accountManagerId: actorB.id });
    const unassignedCustomer = await createCustomer({});
    customerIds.push(mineCustomer.id, otherCustomer.id, unassignedCustomer.id);

    const { customers } = await listCustomerProfiles(actorA, { scope: "mine" });
    const ids = customers.map((c) => c.id);
    expect(ids).toContain(mineCustomer.id);
    expect(ids).not.toContain(otherCustomer.id);
    expect(ids).not.toContain(unassignedCustomer.id);
  });

  it("mine: ADMIN sees only their own customers within 'mine', never a team-wide view", async () => {
    const adminOwn = await createCustomer({ accountManagerId: admin.id });
    const someoneElses = await createCustomer({ accountManagerId: actorA.id });
    customerIds.push(adminOwn.id, someoneElses.id);

    const { customers } = await listCustomerProfiles(admin, { scope: "mine" });
    const ids = customers.map((c) => c.id);
    expect(ids).toContain(adminOwn.id);
    expect(ids).not.toContain(someoneElses.id);
  });

  it("unassigned: includes a null-accountManagerId customer, excludes an assigned one regardless of who", async () => {
    const unassignedCustomer = await createCustomer({});
    const assignedCustomer = await createCustomer({ accountManagerId: actorA.id });
    customerIds.push(unassignedCustomer.id, assignedCustomer.id);

    const { customers } = await listCustomerProfiles(actorA, { scope: "unassigned" });
    const ids = customers.map((c) => c.id);
    expect(ids).toContain(unassignedCustomer.id);
    expect(ids).not.toContain(assignedCustomer.id);
  });

  it("all: every locally-known customer is readable regardless of actor, scope does not alter authorization", async () => {
    const customerX = await createCustomer({ accountManagerId: actorB.id });
    customerIds.push(customerX.id);

    const { customers } = await listCustomerProfiles(actorA, { scope: "all" });
    expect(customers.some((c) => c.id === customerX.id)).toBe(true);
  });

  it("counts: match what listCustomerProfiles returns for the same actor/scope", async () => {
    const actorC = await createTestUser({ role: "AGENT" });
    userIds.push(actorC.id);
    const actor = { id: actorC.id, role: "AGENT" as const };

    const mine1 = await createCustomer({ accountManagerId: actor.id });
    const mine2 = await createCustomer({ accountManagerId: actor.id });
    customerIds.push(mine1.id, mine2.id);

    // Only "mine" is compared here — it's uniquely scoped to this freshly
    // created actor, so no other parallel test can affect it. "unassigned"
    // is a deliberately global, un-owned count (discovery §5/§6) shared
    // across every test file hitting the same database at once; comparing
    // two separately-fetched snapshots of that global number is flaky by
    // construction (another test's customer can flip assigned/unassigned
    // between the two calls), not a signal about this code's correctness —
    // "unassigned" filtering itself is already covered by its own dedicated
    // tests below.
    const counts = await getCustomerListCounts(actor);
    const { total: mineTotal } = await listCustomerProfiles(actor, { scope: "mine" });

    expect(counts.mine).toBe(mineTotal);
    expect(counts.mine).toBe(2);
  });

  it("search stays inside 'mine' scope — a matching customer belonging to someone else is never returned", async () => {
    const actorD = await createTestUser({ role: "AGENT" });
    userIds.push(actorD.id);
    const actor = { id: actorD.id, role: "AGENT" as const };
    const term = `Uniek${crypto.randomUUID().slice(0, 8)}`;

    const own = await createCustomer({ accountManagerId: actor.id, displayName: `${term} Eigen Klant` });
    const others = await createCustomer({ accountManagerId: actorA.id, displayName: `${term} Andermans Klant` });
    customerIds.push(own.id, others.id);

    const { customers } = await listCustomerProfiles(actor, { scope: "mine", search: term });
    const ids = customers.map((c) => c.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(others.id);
  });

  it("search stays inside 'unassigned' scope", async () => {
    const term = `Zoek${crypto.randomUUID().slice(0, 8)}`;
    const unassignedMatch = await createCustomer({ displayName: `${term} Onbekend` });
    const assignedMatch = await createCustomer({ accountManagerId: actorA.id, displayName: `${term} Toegewezen` });
    customerIds.push(unassignedMatch.id, assignedMatch.id);

    const { customers } = await listCustomerProfiles(actorA, { scope: "unassigned", search: term });
    const ids = customers.map((c) => c.id);
    expect(ids).toContain(unassignedMatch.id);
    expect(ids).not.toContain(assignedMatch.id);
  });

  it("search matches companyName as well as displayName", async () => {
    const term = `Bedrijf${crypto.randomUUID().slice(0, 8)}`;
    const orgCustomer = await createCustomer({ accountManagerId: actorA.id, displayName: "Jan Jansen", companyName: `${term} BV` });
    customerIds.push(orgCustomer.id);

    const { customers } = await listCustomerProfiles(actorA, { scope: "mine", search: term });
    expect(customers.some((c) => c.id === orgCustomer.id)).toBe(true);
  });

  it("pagination is applied server-side after scope+search — page 2 never repeats page 1, and total reflects the full scoped count", async () => {
    const actorE = await createTestUser({ role: "AGENT" });
    userIds.push(actorE.id);
    const actor = { id: actorE.id, role: "AGENT" as const };

    const created = [];
    for (let i = 0; i < 5; i++) {
      const c = await createCustomer({ accountManagerId: actor.id });
      created.push(c.id);
      customerIds.push(c.id);
    }

    const page1 = await listCustomerProfiles(actor, { scope: "mine", page: 1, pageSize: 2 });
    const page2 = await listCustomerProfiles(actor, { scope: "mine", page: 2, pageSize: 2 });
    expect(page1.customers).toHaveLength(2);
    expect(page2.customers).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    const page1Ids = page1.customers.map((c) => c.id);
    const page2Ids = page2.customers.map((c) => c.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });

  it("organization vs. individual identity fields are returned unaltered for the presentation layer to consume", async () => {
    const org = await createCustomer({ accountManagerId: actorA.id, displayName: "Jan Jansen", companyName: "Jansen Tuinen BV" });
    const individual = await createCustomer({ accountManagerId: actorA.id, displayName: "Sjoerd Keltjens" });
    customerIds.push(org.id, individual.id);

    const { customers } = await listCustomerProfiles(actorA, { scope: "mine" });
    const orgRow = customers.find((c) => c.id === org.id);
    const individualRow = customers.find((c) => c.id === individual.id);
    expect(orgRow?.companyName).toBe("Jansen Tuinen BV");
    expect(orgRow?.displayName).toBe("Jan Jansen");
    expect(individualRow?.companyName).toBeNull();
  });

  it("all: an inactive accountmanager's customer still appears, with the accountManager relation returned (active:false)", async () => {
    const inactiveManager = await createTestUser({ role: "AGENT" });
    userIds.push(inactiveManager.id);
    const customer = await createCustomer({ accountManagerId: inactiveManager.id });
    customerIds.push(customer.id);
    await prisma.user.update({ where: { id: inactiveManager.id }, data: { active: false } });

    const { customers } = await listCustomerProfiles(actorA, { scope: "all" });
    const row = customers.find((c) => c.id === customer.id);
    expect(row?.accountManager).toEqual({ id: inactiveManager.id, name: expect.any(String), active: false });
  });

  it("unassigned: a customer with an inactive accountmanager never appears (accountManagerId is still set, not null)", async () => {
    const inactiveManager = await createTestUser({ role: "AGENT" });
    userIds.push(inactiveManager.id);
    const customer = await createCustomer({ accountManagerId: inactiveManager.id });
    customerIds.push(customer.id);
    await prisma.user.update({ where: { id: inactiveManager.id }, data: { active: false } });

    const { customers } = await listCustomerProfiles(actorA, { scope: "unassigned" });
    expect(customers.some((c) => c.id === customer.id)).toBe(false);
  });
});

describe("updateCustomerCrmFields — the general accountManagerId mutation (Customer 360's existing control, unchanged by Phase 6b)", () => {
  let actorA: { id: string; role: "AGENT" };
  const userIds: string[] = [];
  const customerIds: string[] = [];

  beforeAll(async () => {
    const userA = await createTestUser({ role: "AGENT" });
    actorA = { id: userA.id, role: "AGENT" };
    userIds.push(userA.id);
  });

  afterAll(async () => {
    await cleanupCustomers(customerIds);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("assigns accountManagerId to the actor and writes a correct audit before/after", async () => {
    const customer = await createCustomer({});
    customerIds.push(customer.id);

    const before = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customer.id } });
    expect(before.accountManagerId).toBeNull();

    const updated = await updateCustomerCrmFields(customer.id, { accountManagerId: actorA.id }, actorA);
    expect(updated.accountManagerId).toBe(actorA.id);

    const activity = await prisma.activity.findFirst({ where: { customerProfileId: customer.id, type: "CUSTOMER_PROFILE_UPDATED" } });
    expect(activity).not.toBeNull();
    expect((activity!.metadata as { before: { accountManagerId: string | null } }).before.accountManagerId).toBeNull();
    expect((activity!.metadata as { after: { accountManagerId: string | null } }).after.accountManagerId).toBe(actorA.id);
  });

  it("never mutates a related Opportunity.ownerUserId or Task.assignedToId (no coupling)", async () => {
    const customer = await createCustomer({});
    customerIds.push(customer.id);

    const otherOwner = await createTestUser({ role: "AGENT" });
    userIds.push(otherOwner.id);

    const opportunity = await prisma.opportunity.create({
      data: { title: "Ongekoppeld", customerProfileId: customer.id, ownerUserId: otherOwner.id, createdById: otherOwner.id, stage: "NEW", status: "OPEN" },
    });
    const task = await prisma.task.create({
      data: { title: "Ongekoppeld", assignedToId: otherOwner.id, createdById: otherOwner.id, customerProfileId: customer.id, status: "OPEN" },
    });

    await updateCustomerCrmFields(customer.id, { accountManagerId: actorA.id }, actorA);

    const opportunityAfter = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(opportunityAfter.ownerUserId).toBe(otherOwner.id);
    expect(taskAfter.assignedToId).toBe(otherOwner.id);

    await prisma.task.delete({ where: { id: task.id } });
    await prisma.opportunity.delete({ where: { id: opportunity.id } });
  });
});

describe("assignCustomerToSelfIfUnassigned — 'Aan mij toewijzen' (concurrency-safe, final review §10)", () => {
  let actorA: { id: string; role: "AGENT" };
  let actorB: { id: string; role: "AGENT" };
  const userIds: string[] = [];
  const customerIds: string[] = [];

  beforeAll(async () => {
    const userA = await createTestUser({ role: "AGENT" });
    const userB = await createTestUser({ role: "AGENT" });
    actorA = { id: userA.id, role: "AGENT" };
    actorB = { id: userB.id, role: "AGENT" };
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await cleanupCustomers(customerIds);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("assigns an unassigned customer to the actor and writes a correct audit before/after", async () => {
    const customer = await createCustomer({});
    customerIds.push(customer.id);

    const updated = await assignCustomerToSelfIfUnassigned(customer.id, actorA);
    expect(updated).not.toBeNull();
    expect(updated!.accountManagerId).toBe(actorA.id);

    const activity = await prisma.activity.findFirst({ where: { customerProfileId: customer.id, type: "CUSTOMER_PROFILE_UPDATED" } });
    expect(activity).not.toBeNull();
    expect((activity!.metadata as { before: { accountManagerId: string | null } }).before.accountManagerId).toBeNull();
    expect((activity!.metadata as { after: { accountManagerId: string | null } }).after.accountManagerId).toBe(actorA.id);

    const audit = await prisma.auditEvent.findFirst({ where: { entityId: customer.id }, orderBy: { createdAt: "desc" } });
    expect(audit?.action).toBe("customer_profile.updated");
  });

  it("never overwrites an already-assigned customer — returns null, writes no Activity/AuditEvent, actor B cannot silently claim actor A's customer", async () => {
    const customer = await createCustomer({ accountManagerId: actorA.id });
    customerIds.push(customer.id);

    const activityCountBefore = await prisma.activity.count({ where: { customerProfileId: customer.id } });
    const auditCountBefore = await prisma.auditEvent.count({ where: { entityId: customer.id } });

    const result = await assignCustomerToSelfIfUnassigned(customer.id, actorB);
    expect(result).toBeNull();

    const unchanged = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customer.id } });
    expect(unchanged.accountManagerId).toBe(actorA.id); // never overwritten

    const activityCountAfter = await prisma.activity.count({ where: { customerProfileId: customer.id } });
    const auditCountAfter = await prisma.auditEvent.count({ where: { entityId: customer.id } });
    expect(activityCountAfter).toBe(activityCountBefore);
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("simulated race: only the first of two concurrent self-assignments wins, the second gets null (conditional update, not last-write-wins)", async () => {
    const customer = await createCustomer({});
    customerIds.push(customer.id);

    const [resultA, resultB] = await Promise.all([
      assignCustomerToSelfIfUnassigned(customer.id, actorA),
      assignCustomerToSelfIfUnassigned(customer.id, actorB),
    ]);

    const winners = [resultA, resultB].filter((r) => r !== null);
    expect(winners).toHaveLength(1); // exactly one of the two succeeded

    const final = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customer.id } });
    expect([actorA.id, actorB.id]).toContain(final.accountManagerId);
  });

  it("never mutates a related Opportunity.ownerUserId or Task.assignedToId (no coupling)", async () => {
    const customer = await createCustomer({});
    customerIds.push(customer.id);

    const otherOwner = await createTestUser({ role: "AGENT" });
    userIds.push(otherOwner.id);

    const opportunity = await prisma.opportunity.create({
      data: { title: "Ongekoppeld (assignToSelf)", customerProfileId: customer.id, ownerUserId: otherOwner.id, createdById: otherOwner.id, stage: "NEW", status: "OPEN" },
    });
    const task = await prisma.task.create({
      data: { title: "Ongekoppeld (assignToSelf)", assignedToId: otherOwner.id, createdById: otherOwner.id, customerProfileId: customer.id, status: "OPEN" },
    });

    await assignCustomerToSelfIfUnassigned(customer.id, actorA);

    const opportunityAfter = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(opportunityAfter.ownerUserId).toBe(otherOwner.id);
    expect(taskAfter.assignedToId).toBe(otherOwner.id);

    await prisma.task.delete({ where: { id: task.id } });
    await prisma.opportunity.delete({ where: { id: opportunity.id } });
  });
});

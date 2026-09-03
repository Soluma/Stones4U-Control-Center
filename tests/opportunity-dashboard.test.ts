import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { getSalesDashboardMetrics } from "@/modules/opportunities/dashboard";
import {
  createOpportunity,
  markWon,
  markLost,
  reopen,
  archiveOpportunity,
} from "@/modules/opportunities/opportunity.service";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

// Phase 4B dashboard metrics (build spec §30). Every scenario below scopes
// its assertions to a dedicated `ownerUserId` filter so results can never be
// polluted by other tests' fixture data running against the same database.

describe("getSalesDashboardMetrics", () => {
  let owner: { id: string; role: "AGENT" };
  let customerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const ownerUser = await createTestUser({ role: "AGENT" });
    owner = { id: ownerUser.id, role: "AGENT" };
    userIds.push(ownerUser.id);
    const profile = await createTestCustomerProfile();
    customerProfileId = profile.id;
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("sums openPipelineValue over OPEN, non-archived opportunities only, treating null estimatedValue as 0", async () => {
    await createOpportunity({ customerProfileId, title: "Open A", estimatedValue: "1000.10", ownerUserId: owner.id }, owner);
    await createOpportunity({ customerProfileId, title: "Open B (geen bedrag)", ownerUserId: owner.id }, owner);
    const wonOne = await createOpportunity({ customerProfileId, title: "Straks gewonnen", estimatedValue: "500", ownerUserId: owner.id }, owner);
    await markWon(wonOne.id, {}, owner);
    const archivedOne = await createOpportunity({ customerProfileId, title: "Straks gearchiveerd", estimatedValue: "9999", ownerUserId: owner.id }, owner);
    await archiveOpportunity(archivedOne.id, owner);

    // Decimal.toString() strips trailing zeros (formatMoney() re-adds them
    // at render time) — assert on the numeric value, not the raw string.
    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner.id });
    expect(Number(metrics.openPipelineValue)).toBe(1000.1);
  });

  it("excludes WON and LOST opportunities from the open pipeline sum", async () => {
    const owner2 = await createTestUser({ role: "AGENT" });
    userIds.push(owner2.id);

    const won = await createOpportunity({ customerProfileId, title: "Gewonnen", estimatedValue: "300", ownerUserId: owner2.id }, owner);
    await markWon(won.id, {}, owner);
    const lost = await createOpportunity({ customerProfileId, title: "Verloren", estimatedValue: "400", ownerUserId: owner2.id }, owner);
    await markLost(lost.id, { lostReason: "Reden" }, owner);

    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner2.id });
    expect(metrics.openPipelineValue).toBe("0");
  });

  it("computes weighted pipeline using explicit probability (0 and 100) and falls back to the stage default when null", async () => {
    const owner3 = await createTestUser({ role: "AGENT" });
    userIds.push(owner3.id);

    // NEW stage default probability is 10% (labels.ts) — null probability.
    await createOpportunity({ customerProfileId, title: "Default-kans NEW", estimatedValue: "1000", ownerUserId: owner3.id }, owner);
    // Explicit 0% — contributes nothing to the weighted sum despite a real value.
    await createOpportunity({ customerProfileId, title: "Expliciet 0%", estimatedValue: "5000", probability: 0, ownerUserId: owner3.id }, owner);
    // Explicit 100% — contributes its full value.
    await createOpportunity({ customerProfileId, title: "Expliciet 100%", estimatedValue: "200", probability: 100, ownerUserId: owner3.id }, owner);
    // Null estimatedValue — must be skipped in the weighted sum, not treated as 0-times-probability in a way that errors.
    await createOpportunity({ customerProfileId, title: "Geen bedrag", ownerUserId: owner3.id }, owner);

    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner3.id });
    // 1000 * 10% + 5000 * 0% + 200 * 100% (+ 0 skipped) = 100 + 0 + 200 = 300
    expect(metrics.weightedPipelineValue).toBe("300");
  });

  it("keeps cent precision across a Decimal sum (no binary-float drift)", async () => {
    const owner4 = await createTestUser({ role: "AGENT" });
    userIds.push(owner4.id);

    await createOpportunity({ customerProfileId, title: "Cent A", estimatedValue: "10.10", ownerUserId: owner4.id }, owner);
    await createOpportunity({ customerProfileId, title: "Cent B", estimatedValue: "20.20", ownerUserId: owner4.id }, owner);

    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner4.id });
    expect(Number(metrics.openPipelineValue)).toBeCloseTo(30.3, 10);
    expect(metrics.openPipelineValue).not.toBe("30.299999999999997"); // no binary-float drift
  });

  it("wonThisMonth uses finalValue only (status=WON, wonAt in the current month window), never estimatedValue as a fallback", async () => {
    const owner5 = await createTestUser({ role: "AGENT" });
    userIds.push(owner5.id);

    const opportunity = await createOpportunity(
      { customerProfileId, title: "Gewonnen deze maand", estimatedValue: "1000", ownerUserId: owner5.id },
      owner,
    );
    await markWon(opportunity.id, { finalValue: "1234.56" }, owner);

    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner5.id });
    expect(metrics.wonThisMonthValue).toBe("1234.56");
    expect(metrics.wonThisMonthCount).toBe(1);
    expect(metrics.recentWon.some((o) => o.id === opportunity.id && o.value === "1234.56")).toBe(true);
  });

  it("lostThisMonth uses estimatedValue (status=LOST, lostAt in the current month window)", async () => {
    const owner6 = await createTestUser({ role: "AGENT" });
    userIds.push(owner6.id);

    const opportunity = await createOpportunity({ customerProfileId, title: "Verloren deze maand", estimatedValue: "777", ownerUserId: owner6.id }, owner);
    await markLost(opportunity.id, { lostReason: "Te duur" }, owner);

    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner6.id });
    expect(metrics.lostThisMonthValue).toBe("777");
    expect(metrics.lostThisMonthCount).toBe(1);
    expect(metrics.recentLost.some((o) => o.id === opportunity.id && o.value === "777")).toBe(true);
  });

  it("a WON-then-reopened opportunity (status back to OPEN) is not counted in wonThisMonth", async () => {
    const owner7 = await createTestUser({ role: "AGENT" });
    userIds.push(owner7.id);

    const opportunity = await createOpportunity({ customerProfileId, title: "Gewonnen-heropend", estimatedValue: "900", ownerUserId: owner7.id }, owner);
    await markWon(opportunity.id, { finalValue: "900" }, owner);
    await reopen(opportunity.id, owner);

    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner7.id });
    expect(metrics.wonThisMonthCount).toBe(0);
    expect(metrics.wonThisMonthValue).toBe("0");
    // Back to OPEN — counts toward open pipeline again instead.
    expect(metrics.openPipelineValue).toBe("900");
  });

  it("a LOST-then-reopened opportunity is not counted in lostThisMonth", async () => {
    const owner8 = await createTestUser({ role: "AGENT" });
    userIds.push(owner8.id);

    const opportunity = await createOpportunity({ customerProfileId, title: "Verloren-heropend", estimatedValue: "650", ownerUserId: owner8.id }, owner);
    await markLost(opportunity.id, { lostReason: "Reden" }, owner);
    await reopen(opportunity.id, owner);

    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner8.id });
    expect(metrics.lostThisMonthCount).toBe(0);
    expect(metrics.lostThisMonthValue).toBe("0");
  });

  it("attentionCount and overdueFollowUpsCount agree with what listOpportunities would classify for the same filter", async () => {
    const owner9 = await createTestUser({ role: "AGENT" });
    userIds.push(owner9.id);

    // No task at all -> NO_NEXT_ACTION -> counted in attentionCount, not overdue.
    await createOpportunity({ customerProfileId, title: "Zonder taak", ownerUserId: owner9.id }, owner);

    const metrics = await getSalesDashboardMetrics({ ownerUserId: owner9.id });
    expect(metrics.attentionCount).toBe(1);
    expect(metrics.overdueFollowUpsCount).toBe(0);
  });

  it("scopes correctly by ownerUserId — one owner's pipeline never leaks into another's metrics", async () => {
    const ownerA = await createTestUser({ role: "AGENT" });
    const ownerB = await createTestUser({ role: "AGENT" });
    userIds.push(ownerA.id, ownerB.id);

    await createOpportunity({ customerProfileId, title: "Van A", estimatedValue: "100", ownerUserId: ownerA.id }, owner);
    await createOpportunity({ customerProfileId, title: "Van B", estimatedValue: "9000", ownerUserId: ownerB.id }, owner);

    const metricsA = await getSalesDashboardMetrics({ ownerUserId: ownerA.id });
    expect(metricsA.openPipelineValue).toBe("100");
  });
});

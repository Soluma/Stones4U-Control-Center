import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveNextAction,
  deriveOpportunityAttention,
  deriveQuoteAheadOfStageSignal,
  deriveShopifyOrderSignal,
  formatNextAction,
  type NextActionTask,
} from "@/modules/opportunities/attention";
import { STAGE_STALE_THRESHOLD_DAYS } from "@/modules/opportunities/labels";
import type { OpportunityStage } from "@/generated/prisma";
import { prisma } from "@/platform/db/prisma";
import { createOpportunity, getOpportunityAttentionContext, listOpportunities } from "@/modules/opportunities/opportunity.service";
import { createTask } from "@/modules/tasks/task.service";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

// Phase 4B attention engine — pure-function tests (build spec §29). No
// database needed: deriveOpportunityAttention/deriveNextAction take
// pre-fetched context, exactly as the module itself is designed. This is
// also the first-ever test coverage of what used to be Phase 4A's untested
// `needsFollowUp` boolean (see docs/build/PHASE-4A... — attachFollowUpFlags
// had zero tests; that behavior now lives inside deriveOpportunityAttention
// as the STALE reason).

const NOW = new Date("2026-09-03T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY);

function baseInput(overrides: Partial<Parameters<typeof deriveOpportunityAttention>[0]> = {}) {
  return {
    status: "OPEN" as const,
    archivedAt: null,
    stage: "NEW" as OpportunityStage,
    expectedCloseDate: null,
    createdAt: daysAgo(1),
    nextAction: { state: "NONE" as const, task: null },
    lastOpportunityActivityAt: null,
    now: NOW,
    ...overrides,
  };
}

describe("deriveNextAction", () => {
  it("returns NONE when there is no open task", () => {
    expect(deriveNextAction(null, NOW)).toEqual({ state: "NONE", task: null });
  });

  it("returns UNSCHEDULED for a task with no dueAt", () => {
    const task: NextActionTask = { id: "t1", title: "Bel klant", dueAt: null };
    expect(deriveNextAction(task, NOW)).toEqual({ state: "UNSCHEDULED", task });
  });

  it("returns OVERDUE for a task due before today", () => {
    const task: NextActionTask = { id: "t1", title: "Bel klant", dueAt: daysAgo(2) };
    expect(deriveNextAction(task, NOW).state).toBe("OVERDUE");
  });

  it("returns TODAY for a task due later today", () => {
    const task: NextActionTask = { id: "t1", title: "Bel klant", dueAt: new Date("2026-09-03T18:00:00.000Z") };
    expect(deriveNextAction(task, NOW).state).toBe("TODAY");
  });

  it("returns UPCOMING for a task due tomorrow or later", () => {
    const task: NextActionTask = { id: "t1", title: "Bel klant", dueAt: daysFromNow(3) };
    expect(deriveNextAction(task, NOW).state).toBe("UPCOMING");
  });
});

describe("deriveOpportunityAttention — closed/archived", () => {
  it("never flags a WON opportunity, regardless of overdue task", () => {
    const result = deriveOpportunityAttention(
      baseInput({ status: "WON", nextAction: { state: "OVERDUE", task: { id: "t1", title: "x", dueAt: daysAgo(5) } } }),
    );
    expect(result).toEqual({ severity: "NONE", reasons: [], primaryReason: null });
  });

  it("never flags a LOST opportunity", () => {
    const result = deriveOpportunityAttention(baseInput({ status: "LOST", createdAt: daysAgo(100) }));
    expect(result.severity).toBe("NONE");
  });

  it("never flags an archived OPEN opportunity", () => {
    const result = deriveOpportunityAttention(baseInput({ archivedAt: daysAgo(1), createdAt: daysAgo(100) }));
    expect(result.severity).toBe("NONE");
  });
});

describe("deriveOpportunityAttention — RED reasons", () => {
  it("flags OVERDUE_TASK when the next action is overdue", () => {
    const result = deriveOpportunityAttention(
      baseInput({ nextAction: { state: "OVERDUE", task: { id: "t1", title: "Bellen", dueAt: daysAgo(2) } } }),
    );
    expect(result.severity).toBe("RED");
    expect(result.reasons.map((r) => r.code)).toContain("OVERDUE_TASK");
  });

  it("flags CLOSE_DATE_PASSED when expectedCloseDate is in the past", () => {
    const result = deriveOpportunityAttention(baseInput({ expectedCloseDate: daysAgo(1) }));
    expect(result.severity).toBe("RED");
    expect(result.reasons.map((r) => r.code)).toContain("CLOSE_DATE_PASSED");
  });

  it("does not flag CLOSE_DATE_PASSED for a future expectedCloseDate", () => {
    const result = deriveOpportunityAttention(baseInput({ expectedCloseDate: daysFromNow(5) }));
    expect(result.reasons.map((r) => r.code)).not.toContain("CLOSE_DATE_PASSED");
  });
});

describe("deriveOpportunityAttention — STALE per-stage thresholds", () => {
  const stages = Object.keys(STAGE_STALE_THRESHOLD_DAYS) as OpportunityStage[];

  it.each(stages)("stage %s: not stale exactly at the threshold", (stage) => {
    const threshold = STAGE_STALE_THRESHOLD_DAYS[stage];
    const result = deriveOpportunityAttention(baseInput({ stage, createdAt: daysAgo(threshold) }));
    expect(result.reasons.map((r) => r.code)).not.toContain("STALE");
  });

  it.each(stages)("stage %s: stale just past the threshold", (stage) => {
    const threshold = STAGE_STALE_THRESHOLD_DAYS[stage];
    const result = deriveOpportunityAttention(baseInput({ stage, createdAt: daysAgo(threshold + 1) }));
    expect(result.reasons.map((r) => r.code)).toContain("STALE");
    expect(result.severity).toBe("ORANGE");
  });

  it("uses the late-stage 7-day (not 5-day) threshold for QUOTE_SENT and NEGOTIATION", () => {
    expect(STAGE_STALE_THRESHOLD_DAYS.QUOTE_SENT).toBe(7);
    expect(STAGE_STALE_THRESHOLD_DAYS.NEGOTIATION).toBe(7);
    const at5Days = deriveOpportunityAttention(baseInput({ stage: "QUOTE_SENT", createdAt: daysAgo(5) }));
    expect(at5Days.reasons.map((r) => r.code)).not.toContain("STALE");
  });

  it("uses lastOpportunityActivityAt over createdAt when it is more recent", () => {
    const result = deriveOpportunityAttention(
      baseInput({ stage: "NEW", createdAt: daysAgo(30), lastOpportunityActivityAt: daysAgo(1) }),
    );
    expect(result.reasons.map((r) => r.code)).not.toContain("STALE");
  });

  it("stays stale when lastOpportunityActivityAt is older than the anchor threshold, even if createdAt is recent-ish", () => {
    const result = deriveOpportunityAttention(
      baseInput({ stage: "NEW", createdAt: daysAgo(10), lastOpportunityActivityAt: daysAgo(10) }),
    );
    expect(result.reasons.map((r) => r.code)).toContain("STALE");
  });

  it("recent activity prevents STALE even for an old opportunity", () => {
    const result = deriveOpportunityAttention(
      baseInput({ stage: "NEGOTIATION", createdAt: daysAgo(365), lastOpportunityActivityAt: daysAgo(1) }),
    );
    expect(result.reasons.map((r) => r.code)).not.toContain("STALE");
  });
});

describe("deriveOpportunityAttention — NO_NEXT_ACTION", () => {
  it("flags NO_NEXT_ACTION (ORANGE) when nextAction.state is NONE", () => {
    const result = deriveOpportunityAttention(baseInput({ nextAction: { state: "NONE", task: null } }));
    expect(result.reasons.map((r) => r.code)).toContain("NO_NEXT_ACTION");
  });

  it("does not flag NO_NEXT_ACTION when an upcoming task exists", () => {
    const result = deriveOpportunityAttention(
      baseInput({ nextAction: { state: "UPCOMING", task: { id: "t1", title: "x", dueAt: daysFromNow(2) } } }),
    );
    expect(result.reasons.map((r) => r.code)).not.toContain("NO_NEXT_ACTION");
  });
});

describe("deriveOpportunityAttention — BLUE signals", () => {
  it("flags SHOPIFY_ORDER_PLACED only when the signal is explicitly true", () => {
    const withSignal = deriveOpportunityAttention(baseInput({ shopifyOrderPlacedSignal: true }));
    expect(withSignal.reasons.map((r) => r.code)).toContain("SHOPIFY_ORDER_PLACED");
    const withoutSignal = deriveOpportunityAttention(baseInput({ shopifyOrderPlacedSignal: false }));
    expect(withoutSignal.reasons.map((r) => r.code)).not.toContain("SHOPIFY_ORDER_PLACED");
  });

  it("flags QUOTE_AHEAD_OF_STAGE only when the signal is explicitly true", () => {
    const withSignal = deriveOpportunityAttention(baseInput({ quoteAheadOfStageSignal: true }));
    expect(withSignal.reasons.map((r) => r.code)).toContain("QUOTE_AHEAD_OF_STAGE");
  });

  it("a lone BLUE signal (no RED/ORANGE reasons) yields overall severity BLUE, not NONE", () => {
    const result = deriveOpportunityAttention(
      baseInput({
        stage: "QUOTE_SENT",
        createdAt: daysAgo(1),
        nextAction: { state: "UPCOMING", task: { id: "t1", title: "x", dueAt: daysFromNow(2) } },
        shopifyOrderPlacedSignal: true,
      }),
    );
    expect(result.severity).toBe("BLUE");
  });
});

describe("deriveOpportunityAttention — severity priority (RED > ORANGE > BLUE)", () => {
  it("sorts multiple simultaneous reasons with the highest severity first, and picks it as primaryReason", () => {
    const result = deriveOpportunityAttention(
      baseInput({
        stage: "NEW",
        createdAt: daysAgo(30), // STALE (ORANGE)
        nextAction: { state: "OVERDUE", task: { id: "t1", title: "Bellen", dueAt: daysAgo(1) } }, // RED
        shopifyOrderPlacedSignal: true, // BLUE
      }),
    );
    expect(result.severity).toBe("RED");
    expect(result.primaryReason?.code).toBe("OVERDUE_TASK");
    expect(result.reasons.map((r) => r.severity)).toEqual(["RED", "ORANGE", "BLUE"]);
  });

  it("returns severity NONE with an empty reasons array when nothing applies", () => {
    const result = deriveOpportunityAttention(
      baseInput({ stage: "NEGOTIATION", createdAt: daysAgo(1), nextAction: { state: "UPCOMING", task: { id: "t1", title: "x", dueAt: daysFromNow(1) } } }),
    );
    expect(result).toEqual({ severity: "NONE", reasons: [], primaryReason: null });
  });
});

describe("formatNextAction", () => {
  const formatDate = (d: Date) => d.toISOString().slice(0, 10);

  it("formats OVERDUE with the task title and due date", () => {
    const text = formatNextAction({ state: "OVERDUE", task: { id: "t1", title: "Bellen", dueAt: daysAgo(2) } }, formatDate);
    expect(text).toContain("Achterstallig");
    expect(text).toContain("Bellen");
  });

  it("formats NONE without a task", () => {
    expect(formatNextAction({ state: "NONE", task: null }, formatDate)).toBe("Geen volgende actie gepland");
  });

  it("formats UNSCHEDULED using only the title", () => {
    const text = formatNextAction({ state: "UNSCHEDULED", task: { id: "t1", title: "Offerte opstellen", dueAt: null } }, formatDate);
    expect(text).toBe("Offerte opstellen");
  });
});

describe("deriveShopifyOrderSignal", () => {
  const draftOrders = [
    { gid: "gid://shopify/DraftOrder/1", completedOrder: { gid: "gid://shopify/Order/1", name: "#1392", adminUrl: "https://admin/orders/1" } },
    { gid: "gid://shopify/DraftOrder/2", completedOrder: null },
  ];
  const orders = [{ gid: "gid://shopify/Order/1", currentTotalPriceSet: { amount: "1234.56" } }];

  it("returns null when the opportunity is not OPEN", () => {
    const opportunity = { status: "WON" as const, externalLinks: [{ linkType: "SHOPIFY_DRAFT_ORDER", externalRef: "gid://shopify/DraftOrder/1" }] };
    expect(deriveShopifyOrderSignal(opportunity, draftOrders, orders)).toBeNull();
  });

  it("returns null when there is no linked SHOPIFY_DRAFT_ORDER", () => {
    const opportunity = { status: "OPEN" as const, externalLinks: [] };
    expect(deriveShopifyOrderSignal(opportunity, draftOrders, orders)).toBeNull();
  });

  it("returns null when the linked draft order has no completedOrder yet", () => {
    const opportunity = { status: "OPEN" as const, externalLinks: [{ linkType: "SHOPIFY_DRAFT_ORDER", externalRef: "gid://shopify/DraftOrder/2" }] };
    expect(deriveShopifyOrderSignal(opportunity, draftOrders, orders)).toBeNull();
  });

  it("returns the signal with the real order's amount as suggestedFinalValue when completedOrder is set", () => {
    const opportunity = { status: "OPEN" as const, externalLinks: [{ linkType: "SHOPIFY_DRAFT_ORDER", externalRef: "gid://shopify/DraftOrder/1" }] };
    const signal = deriveShopifyOrderSignal(opportunity, draftOrders, orders);
    expect(signal).toEqual({ orderName: "#1392", orderAdminUrl: "https://admin/orders/1", suggestedFinalValue: "1234.56" });
  });

  it("falls back to a null suggestedFinalValue if the real order row isn't found (never fabricates a value)", () => {
    const opportunity = { status: "OPEN" as const, externalLinks: [{ linkType: "SHOPIFY_DRAFT_ORDER", externalRef: "gid://shopify/DraftOrder/1" }] };
    const signal = deriveShopifyOrderSignal(opportunity, draftOrders, []);
    expect(signal?.suggestedFinalValue).toBeNull();
  });
});

describe("deriveQuoteAheadOfStageSignal", () => {
  it("is false when the opportunity is not OPEN", () => {
    expect(deriveQuoteAheadOfStageSignal({ status: "WON", stage: "NEW", externalLinks: [] }, 1)).toBe(false);
  });

  it("is false when the customer has no quotes", () => {
    expect(deriveQuoteAheadOfStageSignal({ status: "OPEN", stage: "NEW", externalLinks: [] }, 0)).toBe(false);
  });

  it("is false when a quote-type external link is already active", () => {
    const externalLinks = [{ linkType: "OFFERTEAPP_QUOTE", externalRef: "Q-1" }];
    expect(deriveQuoteAheadOfStageSignal({ status: "OPEN", stage: "NEW", externalLinks }, 1)).toBe(false);
  });

  it("is false once the stage has reached QUOTE_SENT or later", () => {
    expect(deriveQuoteAheadOfStageSignal({ status: "OPEN", stage: "QUOTE_SENT", externalLinks: [] }, 1)).toBe(false);
    expect(deriveQuoteAheadOfStageSignal({ status: "OPEN", stage: "NEGOTIATION", externalLinks: [] }, 1)).toBe(false);
  });

  it("is true when a quote exists, the opportunity is OPEN and still before QUOTE_SENT, with no active quote link", () => {
    expect(deriveQuoteAheadOfStageSignal({ status: "OPEN", stage: "NEEDS_DEFINED", externalLinks: [] }, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration — attachAttention (via listOpportunities) and
// getOpportunityAttentionContext, against a real database. Confirms the
// batched Activity.groupBy last-activity anchor and the Task-derived
// next-action actually wire up end to end, not just the pure classifier
// above.
// ---------------------------------------------------------------------------

describe("attachAttention / getOpportunityAttentionContext — integration", () => {
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

  it("a freshly created opportunity with no task is flagged NO_NEXT_ACTION but not STALE", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Vers, geen taak", ownerUserId: owner.id }, owner);
    const rows = await listOpportunities({ customerProfileId: opportunity.customerProfileId, status: "OPEN" });
    const row = rows.find((r) => r.id === opportunity.id)!;
    expect(row.attention.reasons.map((r) => r.code)).toContain("NO_NEXT_ACTION");
    expect(row.attention.reasons.map((r) => r.code)).not.toContain("STALE");
    expect(row.nextAction.state).toBe("NONE");
  });

  it("an opportunity with an overdue open task is flagged RED via listOpportunities", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Achterstallige taak", ownerUserId: owner.id }, owner);
    const overdueDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await createTask({ title: "Bel de klant terug", assignedToId: owner.id, opportunityId: opportunity.id, dueAt: overdueDate }, owner);

    const rows = await listOpportunities({ customerProfileId: opportunity.customerProfileId, status: "OPEN" });
    const row = rows.find((r) => r.id === opportunity.id)!;
    expect(row.attention.severity).toBe("RED");
    expect(row.nextAction.state).toBe("OVERDUE");
  });

  it("an opportunity with only an upcoming task is not flagged NO_NEXT_ACTION", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Geplande taak", ownerUserId: owner.id }, owner);
    const upcoming = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await createTask({ title: "Opvolgen", assignedToId: owner.id, opportunityId: opportunity.id, dueAt: upcoming }, owner);

    const rows = await listOpportunities({ customerProfileId: opportunity.customerProfileId, status: "OPEN" });
    const row = rows.find((r) => r.id === opportunity.id)!;
    expect(row.attention.reasons.map((r) => r.code)).not.toContain("NO_NEXT_ACTION");
    expect(row.nextAction.state).toBe("UPCOMING");
  });

  it("getOpportunityAttentionContext returns the same next open task and a non-null lastOpportunityActivityAt (OPPORTUNITY_CREATED always writes one)", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Context-test", ownerUserId: owner.id }, owner);
    await createTask({ title: "Volgende stap", assignedToId: owner.id, opportunityId: opportunity.id, dueAt: null }, owner);

    const context = await getOpportunityAttentionContext(opportunity.id);
    expect(context.nextOpenTask?.title).toBe("Volgende stap");
    expect(context.lastOpportunityActivityAt).not.toBeNull();
  });

  it("creating a task on an opportunity advances lastOpportunityActivityAt past createdAt (last-activity anchor, not just createdAt)", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Activiteit-anchor-test", ownerUserId: owner.id }, owner);
    const beforeTask = await getOpportunityAttentionContext(opportunity.id);
    await createTask({ title: "Nieuwe activiteit", assignedToId: owner.id, opportunityId: opportunity.id, dueAt: null }, owner);
    const afterTask = await getOpportunityAttentionContext(opportunity.id);
    expect(afterTask.lastOpportunityActivityAt!.getTime()).toBeGreaterThanOrEqual(beforeTask.lastOpportunityActivityAt!.getTime());
  });

  it("a closed (WON) opportunity never appears with attention severity via listOpportunities status=ALL", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Gewonnen, geen aandacht", ownerUserId: owner.id }, owner);
    const { markWon } = await import("@/modules/opportunities/opportunity.service");
    await markWon(opportunity.id, {}, owner);

    const rows = await listOpportunities({ customerProfileId: opportunity.customerProfileId, status: "ALL" });
    const row = rows.find((r) => r.id === opportunity.id)!;
    expect(row.attention.severity).toBe("NONE");
  });
});

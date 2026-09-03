import "server-only";
import { prisma } from "@/platform/db/prisma";
import { Prisma } from "@/generated/prisma";
import type { OpportunityStage } from "@/generated/prisma";
import { STAGE_DEFAULT_PROBABILITY } from "./labels";
import { listOpportunities } from "./opportunity.service";
import { customerDisplayName } from "@/modules/crm/customer-identity";

// Phase 4B sales dashboard metrics (docs/platform-discovery/35-PHASE-4B-
// SALES-ACTIVATION-ARCHITECTURE.md §9, docs/platform-discovery/36 §8-11).
// Exact query semantics are deliberately spelled out (not left implicit) so
// a future developer never has to guess at status vs. wonAt/lostAt
// ambiguity — see the inline comments below and ADR-009.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SalesDashboardFilter = {
  ownerUserId?: string;
  stage?: OpportunityStage;
};

export type RecentClosedOpportunity = {
  id: string;
  title: string;
  customerName: string;
  value: string | null; // Decimal.toString() — presentation only, formatMoney() at render time
  closedAt: string; // ISO
};

export type SalesDashboardMetrics = {
  // A/B — Decimal, formatted via formatMoney() at render time. Never a JS
  // Number sum (build spec §9/§10).
  openPipelineValue: string;
  weightedPipelineValue: string;
  // C/D — counts, reuse the exact same attention/next-action classification
  // the pipeline page itself uses (via listOpportunities()), so the
  // dashboard number can never disagree with what the pipeline shows for
  // the same filter.
  attentionCount: number;
  overdueFollowUpsCount: number;
  // E — fixed 30-day horizon, no date-range builder (build spec §0).
  expectedClosesNext30DaysCount: number;
  // F/G — current calendar month, filtered on `status` (the canonical-state
  // authority, ADR-009) combined with wonAt/lostAt for the month window —
  // never `wonAt/lostAt IS NOT NULL` alone.
  wonThisMonthValue: string;
  wonThisMonthCount: number;
  lostThisMonthValue: string;
  lostThisMonthCount: number;
  // H — fixed 30-day window (distinct from the "this month" value metrics
  // above — build spec §0 asks for these as two separate windows).
  recentWon: RecentClosedOpportunity[];
  recentLost: RecentClosedOpportunity[];
};

export async function getSalesDashboardMetrics(filter: SalesDashboardFilter = {}): Promise<SalesDashboardMetrics> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const in30Days = new Date(now.getTime() + 30 * MS_PER_DAY);
  const last30Days = new Date(now.getTime() - 30 * MS_PER_DAY);

  const openWhere: Prisma.OpportunityWhereInput = {
    status: "OPEN",
    archivedAt: null,
    ...(filter.ownerUserId ? { ownerUserId: filter.ownerUserId } : {}),
    ...(filter.stage ? { stage: filter.stage } : {}),
  };
  const ownerWhere = filter.ownerUserId ? { ownerUserId: filter.ownerUserId } : {};

  const [openOpportunities, openSumAgg, wonAgg, lostAgg, recentWonRows, recentLostRows] = await Promise.all([
    // Reused, not reimplemented — build spec §8's "aandacht"/"overdue"
    // counts must exactly match what /opportunities itself shows for the
    // same filter (§9 architecture doc's own stated design goal).
    listOpportunities({ status: "OPEN", ownerUserId: filter.ownerUserId, stage: filter.stage }),

    // Pipeline value — native Postgres SUM via Prisma aggregate. Null when
    // there are no open opportunities (or all have a null estimatedValue) —
    // treated as 0 below, per build spec §9 "Null estimatedValue: behandel
    // als 0 voor aggregation."
    prisma.opportunity.aggregate({ where: openWhere, _sum: { estimatedValue: true } }),

    // Won this month — status is always part of the filter (ADR-009: status
    // is the canonical-state authority), combined with the wonAt month
    // window. finalValue is used directly (never estimatedValue as a
    // fallback here) — a WON deal with no finalValue at all (the rare case
    // where estimatedValue was also never set, architecture doc §9)
    // contributes 0, a documented, accepted limitation, not a bug.
    prisma.opportunity.aggregate({
      where: { status: "WON", wonAt: { gte: startOfMonth, lt: startOfNextMonth }, ...ownerWhere },
      _sum: { finalValue: true },
      _count: true,
    }),

    // Lost this month — estimatedValue is the only figure ever known for a
    // lost deal.
    prisma.opportunity.aggregate({
      where: { status: "LOST", lostAt: { gte: startOfMonth, lt: startOfNextMonth }, ...ownerWhere },
      _sum: { estimatedValue: true },
      _count: true,
    }),

    prisma.opportunity.findMany({
      where: { status: "WON", wonAt: { gte: last30Days }, ...ownerWhere },
      orderBy: { wonAt: "desc" },
      take: 8,
      select: {
        id: true,
        title: true,
        finalValue: true,
        wonAt: true,
        customerProfile: { select: { displayName: true, companyName: true, customerTypeOverride: true } },
      },
    }),

    prisma.opportunity.findMany({
      where: { status: "LOST", lostAt: { gte: last30Days }, ...ownerWhere },
      orderBy: { lostAt: "desc" },
      take: 8,
      select: {
        id: true,
        title: true,
        estimatedValue: true,
        lostAt: true,
        customerProfile: { select: { displayName: true, companyName: true, customerTypeOverride: true } },
      },
    }),
  ]);

  // Weighted pipeline — the stage-default probability fallback exists only
  // in TypeScript (labels.ts), never in the database, so this cannot be a
  // pure SQL aggregate. Fetches only the 3 needed columns (via
  // listOpportunities, already fetched above for the attention counts —
  // no extra query) and accumulates with Prisma.Decimal arithmetic only —
  // never Number() (build spec §10).
  const weighted = openOpportunities.reduce((sum, o) => {
    if (!o.estimatedValue) return sum;
    const probability = o.probability ?? STAGE_DEFAULT_PROBABILITY[o.stage];
    return sum.plus(o.estimatedValue.times(probability).dividedBy(100));
  }, new Prisma.Decimal(0));

  const attentionCount = openOpportunities.filter((o) => o.attention.severity !== "NONE").length;
  const overdueFollowUpsCount = openOpportunities.filter((o) => o.nextAction.state === "OVERDUE").length;
  const expectedClosesNext30DaysCount = openOpportunities.filter(
    (o) => o.expectedCloseDate && o.expectedCloseDate.getTime() >= now.getTime() && o.expectedCloseDate.getTime() <= in30Days.getTime(),
  ).length;

  return {
    openPipelineValue: (openSumAgg._sum.estimatedValue ?? new Prisma.Decimal(0)).toString(),
    weightedPipelineValue: weighted.toString(),
    attentionCount,
    overdueFollowUpsCount,
    expectedClosesNext30DaysCount,
    wonThisMonthValue: (wonAgg._sum.finalValue ?? new Prisma.Decimal(0)).toString(),
    wonThisMonthCount: wonAgg._count,
    lostThisMonthValue: (lostAgg._sum.estimatedValue ?? new Prisma.Decimal(0)).toString(),
    lostThisMonthCount: lostAgg._count,
    recentWon: recentWonRows.map((o) => ({
      id: o.id,
      title: o.title,
      customerName: customerDisplayName(o.customerProfile),
      value: o.finalValue?.toString() ?? null,
      closedAt: o.wonAt!.toISOString(),
    })),
    recentLost: recentLostRows.map((o) => ({
      id: o.id,
      title: o.title,
      customerName: customerDisplayName(o.customerProfile),
      value: o.estimatedValue?.toString() ?? null,
      closedAt: o.lostAt!.toISOString(),
    })),
  };
}

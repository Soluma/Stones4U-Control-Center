import type { OpportunityStage, OpportunityStatus } from "@/generated/prisma";
import { STAGE_ORDER, STAGE_STALE_THRESHOLD_DAYS } from "./labels";

// Phase 4B attention engine (docs/platform-discovery/35-PHASE-4B-SALES-
// ACTIVATION-ARCHITECTURE.md §1). Pure functions only — no database access
// here. Callers (opportunity.service.ts's listOpportunities/
// getOpportunityDetail) gather the required data via the same batched
// queries already used for the Phase 4A `needsFollowUp` flag; this module
// only classifies what's handed to it.

export type AttentionSeverity = "RED" | "ORANGE" | "BLUE" | "NONE";

export type AttentionReasonCode =
  | "OVERDUE_TASK"
  | "CLOSE_DATE_PASSED"
  | "STALE"
  | "NO_NEXT_ACTION"
  | "SHOPIFY_ORDER_PLACED"
  | "QUOTE_AHEAD_OF_STAGE";

export type AttentionReason = {
  code: AttentionReasonCode;
  severity: Exclude<AttentionSeverity, "NONE">;
  label: string;
};

export type OpportunityAttention = {
  severity: AttentionSeverity;
  reasons: AttentionReason[];
  primaryReason: AttentionReason | null;
};

const SEVERITY_RANK: Record<Exclude<AttentionSeverity, "NONE">, number> = { RED: 3, ORANGE: 2, BLUE: 1 };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Next action — Task is the sole source of truth, no stored duplicate.
// ---------------------------------------------------------------------------

export type NextActionState = "OVERDUE" | "TODAY" | "UPCOMING" | "UNSCHEDULED" | "NONE";

export type NextActionTask = { id: string; title: string; dueAt: Date | null };

export type NextActionInfo = {
  state: NextActionState;
  task: NextActionTask | null;
};

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `nextOpenTask` must already be scoped to THIS opportunity (via
 * Task.opportunityId) — a customer-wide task must never be passed in here
 * as if it were this opportunity's next action (build spec §4). */
export function deriveNextAction(nextOpenTask: NextActionTask | null, now: Date = new Date()): NextActionInfo {
  if (!nextOpenTask) return { state: "NONE", task: null };
  if (!nextOpenTask.dueAt) return { state: "UNSCHEDULED", task: nextOpenTask };

  const todayStart = startOfDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + MS_PER_DAY);

  if (nextOpenTask.dueAt < todayStart) return { state: "OVERDUE", task: nextOpenTask };
  if (nextOpenTask.dueAt < tomorrowStart) return { state: "TODAY", task: nextOpenTask };
  return { state: "UPCOMING", task: nextOpenTask };
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

export type DeriveAttentionInput = {
  status: OpportunityStatus;
  archivedAt: Date | null;
  stage: OpportunityStage;
  expectedCloseDate: Date | null;
  createdAt: Date;
  nextAction: NextActionInfo;
  /** Latest occurredAt among this opportunity's own Activity rows
   * (relatedOpportunityId-scoped) — build spec §5: every ActivityType
   * written with relatedOpportunityId set counts (OPPORTUNITY_CREATED/
   * _STAGE_CHANGED/_WON/_LOST/_REOPENED, TASK_*, NOTE_*, APPOINTMENT_*,
   * FILE_*) — never a customer-wide call/email timestamp (build spec §6/§7:
   * those are never opportunity-specific, so they must never feed this
   * anchor). Never null in practice (OPPORTUNITY_CREATED is always written
   * at creation) — the createdAt fallback below is defensive only. */
  lastOpportunityActivityAt: Date | null;
  /** Only known where already live-fetched (opportunity detail page) — a
   * linked, unlinked-null SHOPIFY_DRAFT_ORDER external link whose
   * ShopifyDraftOrderSummary.completedOrder is non-null. Never fetched
   * per pipeline card (build spec §20). */
  shopifyOrderPlacedSignal?: boolean;
  /** Only known where already live-fetched (opportunity detail page) — the
   * customer has at least one federated quote and this opportunity's stage
   * is still before QUOTE_SENT with no quote-type external link yet. */
  quoteAheadOfStageSignal?: boolean;
  now?: Date;
};

export function deriveOpportunityAttention(input: DeriveAttentionInput): OpportunityAttention {
  const now = input.now ?? new Date();

  // Closed or archived opportunities never need attention — nothing left
  // to follow up on (build spec §7: "Closed opportunities: nooit stale.
  // Archived: niet in actieve attention.").
  if (input.status !== "OPEN" || input.archivedAt) {
    return { severity: "NONE", reasons: [], primaryReason: null };
  }

  const reasons: AttentionReason[] = [];

  if (input.nextAction.state === "OVERDUE") {
    reasons.push({ code: "OVERDUE_TASK", severity: "RED", label: "Openstaande taak is achterstallig" });
  }
  if (input.expectedCloseDate && input.expectedCloseDate.getTime() < now.getTime()) {
    reasons.push({ code: "CLOSE_DATE_PASSED", severity: "RED", label: "Verwachte sluitdatum is verstreken" });
  }

  // Stale anchor: the most recent of createdAt / last opportunity Activity
  // — never a customer-wide call/email timestamp (build spec §7). In
  // practice lastOpportunityActivityAt is never earlier than createdAt
  // (OPPORTUNITY_CREATED is always the first Activity row), but the max()
  // is kept explicit so this stays correct even if that invariant is ever
  // violated by a future change.
  const anchor =
    input.lastOpportunityActivityAt && input.lastOpportunityActivityAt.getTime() > input.createdAt.getTime()
      ? input.lastOpportunityActivityAt
      : input.createdAt;
  const daysSinceAnchor = (now.getTime() - anchor.getTime()) / MS_PER_DAY;
  const thresholdDays = STAGE_STALE_THRESHOLD_DAYS[input.stage];
  if (daysSinceAnchor > thresholdDays) {
    reasons.push({ code: "STALE", severity: "ORANGE", label: `Geen activiteit in meer dan ${thresholdDays} dagen` });
  }

  if (input.nextAction.state === "NONE") {
    reasons.push({ code: "NO_NEXT_ACTION", severity: "ORANGE", label: "Geen volgende actie gepland" });
  }

  if (input.shopifyOrderPlacedSignal) {
    reasons.push({ code: "SHOPIFY_ORDER_PLACED", severity: "BLUE", label: "Bestelling geplaatst — markeer als gewonnen?" });
  }
  if (input.quoteAheadOfStageSignal) {
    reasons.push({
      code: "QUOTE_AHEAD_OF_STAGE",
      severity: "BLUE",
      label: "Er is een offerte aanwezig terwijl deze verkoopkans nog in een eerdere fase staat",
    });
  }

  if (reasons.length === 0) return { severity: "NONE", reasons: [], primaryReason: null };

  const sorted = [...reasons].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return { severity: sorted[0]!.severity, reasons: sorted, primaryReason: sorted[0]! };
}

// ---------------------------------------------------------------------------
// Shared presentation helper — one definition, used by both the pipeline
// board (client) and the opportunity detail page (server); this module has
// no "server-only" import so both can use it.
// ---------------------------------------------------------------------------

const NEXT_ACTION_TEXT: Record<NextActionState, (task: NextActionTask | null, formatDate: (d: Date) => string) => string> = {
  OVERDUE: (t, f) => `Achterstallig: ${t!.title}${t!.dueAt ? ` (${f(t!.dueAt)})` : ""}`,
  TODAY: (t) => `Vandaag: ${t!.title}`,
  UPCOMING: (t, f) => `${t!.title} (${f(t!.dueAt!)})`,
  UNSCHEDULED: (t) => t!.title,
  NONE: () => "Geen volgende actie gepland",
};

export function formatNextAction(nextAction: NextActionInfo, formatDate: (d: Date) => string): string {
  return NEXT_ACTION_TEXT[nextAction.state](nextAction.task, formatDate);
}

// ---------------------------------------------------------------------------
// Detail-page-only BLUE signals (architecture doc §6/§7, build spec §18-21).
// Pure cross-references over data the detail page has already fetched for
// OpportunityCommercialLinks — never a new Shopify/quote lookup of their
// own. Extracted here (rather than left inline in the page component) so
// they're unit-testable without a database or a live Shopify call.
// ---------------------------------------------------------------------------

export type ExternalLinkRef = { linkType: string; externalRef: string };
export type DraftOrderSignalInput = { gid: string; completedOrder: { gid: string; name: string; adminUrl: string } | null };
export type OrderSignalInput = { gid: string; currentTotalPriceSet: { amount: string } };

export type ShopifyOrderSignal = { orderName: string; orderAdminUrl: string; suggestedFinalValue: string | null };

/** Only ever true for an OPEN opportunity with an actively-linked
 * SHOPIFY_DRAFT_ORDER whose ShopifyDraftOrderSummary.completedOrder is
 * non-null — the link itself was already cross-customer-verified at link
 * time (Phase 4A, `assertShopifyDocumentBelongsToCustomer`), so no new
 * verification is needed here. Never calls markWon() itself — purely
 * classifies whether the banner should appear; the actual mutation only
 * happens via an explicit human confirmation in ShopifyOrderSignalBanner. */
export function deriveShopifyOrderSignal(
  opportunity: { status: OpportunityStatus; externalLinks: ExternalLinkRef[] },
  draftOrders: DraftOrderSignalInput[],
  orders: OrderSignalInput[],
): ShopifyOrderSignal | null {
  if (opportunity.status !== "OPEN") return null;
  const linkedDraftOrderRef = opportunity.externalLinks.find((l) => l.linkType === "SHOPIFY_DRAFT_ORDER")?.externalRef;
  const linkedDraftOrder = linkedDraftOrderRef ? draftOrders.find((d) => d.gid === linkedDraftOrderRef) : undefined;
  if (!linkedDraftOrder?.completedOrder) return null;

  const realOrder = orders.find((o) => o.gid === linkedDraftOrder.completedOrder!.gid);
  return {
    orderName: linkedDraftOrder.completedOrder.name,
    orderAdminUrl: linkedDraftOrder.completedOrder.adminUrl,
    suggestedFinalValue: realOrder?.currentTotalPriceSet.amount ?? null,
  };
}

/** True only when the customer has at least one federated quote, this
 * opportunity is OPEN and still in an early stage (before QUOTE_SENT), and
 * no quote-type external link is active on it yet. Purely informational —
 * never triggers changeStage() itself. */
export function deriveQuoteAheadOfStageSignal(
  opportunity: { status: OpportunityStatus; stage: OpportunityStage; externalLinks: ExternalLinkRef[] },
  quoteCount: number,
): boolean {
  if (opportunity.status !== "OPEN") return false;
  if (quoteCount === 0) return false;
  const hasActiveQuoteLink = opportunity.externalLinks.some((l) => l.linkType === "OFFERTEAPP_QUOTE" || l.linkType === "S4U_QUOTE_APP_QUOTE");
  if (hasActiveQuoteLink) return false;
  return STAGE_ORDER.indexOf(opportunity.stage) < STAGE_ORDER.indexOf("QUOTE_SENT");
}

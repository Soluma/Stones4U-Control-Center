import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import { getShopifyCustomerOrders } from "@/integrations/shopify/orders";
import { getShopifyCustomerDraftOrders } from "@/integrations/shopify/draft-orders";
import { STAGE_LABEL } from "./labels";
import { Prisma } from "@/generated/prisma";
import type { Role, OpportunityStage, OpportunityLinkType } from "@/generated/prisma";

// Central Opportunity service layer (docs/architecture/ADR-009-OPPORTUNITY-
// PIPELINE-MODEL.md, docs/platform-discovery/33-PHASE-4A-BUILD-SPEC.md).
// Every mutation route delegates here — no business logic in route
// handlers/components (build spec §6).

type Actor = { id: string; role: Role };

export class OpportunityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpportunityValidationError";
  }
}

const FOLLOW_UP_INACTIVITY_DAYS = 7;

// Same creator/assignee/admin shape as Task.assertCanModify and
// Appointment.assertCanModify (architecture doc §12) — deliberately
// reimplemented per-domain rather than shared, so Task/Appointment/Opportunity stay
// independently typed and don't couple unrelated domains together.
function assertCanModify(opportunity: { ownerUserId: string; createdById: string }, actor: Actor) {
  if (actor.role === "ADMIN") return;
  if (actor.id === opportunity.ownerUserId || actor.id === opportunity.createdById) return;
  throw new ForbiddenError("Alleen de eigenaar, aanmaker, of een beheerder mag deze verkoopkans wijzigen.");
}

function assertNotArchived(opportunity: { archivedAt: Date | null }) {
  if (opportunity.archivedAt) {
    throw new OpportunityValidationError("Deze verkoopkans is gearchiveerd en kan niet meer gewijzigd worden.");
  }
}

function validateTitle(title: string) {
  if (title.trim().length === 0) throw new OpportunityValidationError("Titel is verplicht.");
  if (title.length > 200) throw new OpportunityValidationError("Titel is te lang (max 200 tekens).");
}

function validateProbability(probability: number | null | undefined) {
  if (probability == null) return;
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    throw new OpportunityValidationError("Kans moet een geheel getal tussen 0 en 100 zijn.");
  }
}

// Strict money parser — pre-production review finding B/4: bare Number()
// coercion accepted exponential notation, over-precision, and out-of-range
// values, which then either got silently stored via a lossy path or hit an
// unhandled Decimal(12,2) overflow at the database (a generic 500, not a
// clean validation error). This is now the single place estimatedValue/
// finalValue are parsed, for both create and update, returning a
// Prisma.Decimal (or null for "no value") that is handed to Prisma
// unchanged — never a JS float round-trip for the stored value itself.
const MONEY_DECIMAL_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
const MAX_MONEY_VALUE = new Prisma.Decimal("9999999999.99");

function parseMoneyInput(value: string | number | null | undefined, label: string): Prisma.Decimal | null {
  if (value == null || value === "") return null;

  let candidate: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OpportunityValidationError(`${label} moet een geldig bedrag zijn.`);
    }
    // Defensive normalization for the number-input path only — strings are
    // validated exactly as given, never rounded. toFixed(2) collapses
    // harmless binary-float noise (e.g. 0.1 + 0.2 -> 0.30000000000000004)
    // but is rejected, not silently rounded, when it would actually
    // discard a real third decimal the caller intended (e.g. 10.123).
    const fixed = value.toFixed(2);
    if (Math.abs(Number(fixed) - value) > 1e-9) {
      throw new OpportunityValidationError(`${label} mag maximaal 2 decimalen hebben.`);
    }
    candidate = fixed;
  } else if (typeof value === "string") {
    candidate = value.trim();
  } else {
    throw new OpportunityValidationError(`${label} moet een geldig bedrag zijn.`);
  }

  // Deliberately strict: unsigned, plain decimal digits only — no exponent
  // notation, no leading "+"/"-", no thousands separators, max 2 decimals.
  // This alone also rejects "NaN"/"Infinity"/negative values (they can
  // never match), without ever calling Number() as the validator.
  if (!MONEY_DECIMAL_PATTERN.test(candidate)) {
    throw new OpportunityValidationError(
      `${label} moet een geldig bedrag zijn (bijv. 1234.56) — geen minteken, exponentnotatie, of meer dan 2 decimalen.`,
    );
  }

  const decimal = new Prisma.Decimal(candidate);
  if (decimal.greaterThan(MAX_MONEY_VALUE)) {
    throw new OpportunityValidationError(`${label} is te groot (max ${MAX_MONEY_VALUE.toString()}).`);
  }

  return decimal;
}

async function assertUserExistsAndActive(userId: string, label: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { active: true } });
  if (!user || !user.active) throw new OpportunityValidationError(`${label} bestaat niet of is niet actief.`);
}

async function assertCustomerExists(customerProfileId: string) {
  const customer = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: { id: true, accountManagerId: true },
  });
  if (!customer) throw new OpportunityValidationError("Klant bestaat niet.");
  return customer;
}

export const opportunityListInclude = {
  customerProfile: { select: { id: true, displayName: true, companyName: true } },
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

export const opportunityDetailInclude = {
  ...opportunityListInclude,
  externalLinks: {
    where: { unlinkedAt: null },
    orderBy: { linkedAt: "desc" as const },
    include: { linkedBy: { select: { id: true, name: true } } },
  },
} as const;

// ---------------------------------------------------------------------------
// Create / read / list
// ---------------------------------------------------------------------------

export async function createOpportunity(
  input: {
    customerProfileId: string;
    title: string;
    description?: string | null;
    estimatedValue?: string | number | null;
    probability?: number | null;
    expectedCloseDate?: Date | null;
    ownerUserId?: string | null;
  },
  actor: Actor,
) {
  validateTitle(input.title);
  validateProbability(input.probability);
  const estimatedValue = parseMoneyInput(input.estimatedValue, "Geschatte waarde");

  const customer = await assertCustomerExists(input.customerProfileId);

  // Pre-production review finding D/5: an opportunity must never be
  // silently assigned to an inactive user. The explicit-owner path already
  // enforced this; the default (accountmanager-derived) path did not.
  let ownerUserId = input.ownerUserId ?? null;
  if (ownerUserId) {
    await assertUserExistsAndActive(ownerUserId, "Eigenaar");
  } else if (customer.accountManagerId) {
    const accountManager = await prisma.user.findUnique({
      where: { id: customer.accountManagerId },
      select: { active: true },
    });
    // Active accountmanager -> use them. Missing or inactive -> fall back
    // to the creator (who is guaranteed active by the session layer that
    // authenticated this request in the first place) — never a silent
    // assignment to an inactive user.
    ownerUserId = accountManager?.active ? customer.accountManagerId : actor.id;
  } else {
    ownerUserId = actor.id;
  }

  const opportunity = await prisma.$transaction(async (tx) => {
    const created = await tx.opportunity.create({
      data: {
        customerProfileId: input.customerProfileId,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        estimatedValue,
        probability: input.probability ?? null,
        expectedCloseDate: input.expectedCloseDate ?? null,
        ownerUserId: ownerUserId!,
        createdById: actor.id,
      },
      include: opportunityListInclude,
    });

    await tx.activity.create({
      data: {
        customerProfileId: created.customerProfileId,
        type: "OPPORTUNITY_CREATED",
        sourceType: "CONTROL_CENTER",
        title: `Verkoopkans aangemaakt: ${created.title}`,
        occurredAt: created.createdAt,
        actorId: actor.id,
        relatedOpportunityId: created.id,
      },
    });

    return created;
  });

  await logAudit({
    userId: actor.id,
    action: "opportunity.created",
    entityType: "Opportunity",
    entityId: opportunity.id,
    metadata: { customerProfileId: input.customerProfileId, ownerUserId },
  });

  return opportunity;
}

export async function getOpportunityDetail(id: string) {
  return prisma.opportunity.findUniqueOrThrow({ where: { id }, include: opportunityDetailInclude });
}

export type OpportunityListFilter = {
  status?: "OPEN" | "WON" | "LOST" | "ALL";
  stage?: OpportunityStage;
  ownerUserId?: string;
  customerProfileId?: string;
  search?: string;
  archived?: "exclude" | "only" | "all";
};

type OpportunityListRow = Prisma.OpportunityGetPayload<{
  include: typeof opportunityListInclude & { tasks: { select: { id: true; title: true; dueAt: true } } };
}>;

/** Attaches a purely-computed "needsFollowUp" flag (architecture doc §17) —
 * one batched Activity groupBy query for the whole visible page, never a
 * per-row query, and never a stored column. */
async function attachFollowUpFlags(
  opportunities: OpportunityListRow[],
): Promise<(OpportunityListRow & { needsFollowUp: boolean })[]> {
  const openIds = opportunities.filter((o) => o.status === "OPEN").map((o) => o.id);
  const lastActivityRows = openIds.length
    ? await prisma.activity.groupBy({
        by: ["relatedOpportunityId"],
        where: { relatedOpportunityId: { in: openIds } },
        _max: { occurredAt: true },
      })
    : [];
  const lastActivityMap = new Map(lastActivityRows.map((row) => [row.relatedOpportunityId, row._max.occurredAt]));

  const now = new Date();
  const inactivityCutoff = new Date(now.getTime() - FOLLOW_UP_INACTIVITY_DAYS * 24 * 60 * 60 * 1000);

  return opportunities.map((opportunity) => {
    if (opportunity.status !== "OPEN") return { ...opportunity, needsFollowUp: false };

    const overdueOpenTask = opportunity.tasks.some((t) => t.dueAt && t.dueAt < now);
    const closeDatePassed = !!opportunity.expectedCloseDate && opportunity.expectedCloseDate < now;
    const lastActivityAt = lastActivityMap.get(opportunity.id) ?? null;
    const oldEnough = opportunity.createdAt < inactivityCutoff;
    const noRecentActivity = oldEnough && (!lastActivityAt || lastActivityAt < inactivityCutoff);

    return { ...opportunity, needsFollowUp: overdueOpenTask || closeDatePassed || noRecentActivity };
  });
}

export async function listOpportunities(filter: OpportunityListFilter = {}) {
  const where: Prisma.OpportunityWhereInput = {};

  if (!filter.status || filter.status === "OPEN") where.status = "OPEN";
  else if (filter.status !== "ALL") where.status = filter.status;

  if (filter.stage) where.stage = filter.stage;
  if (filter.ownerUserId) where.ownerUserId = filter.ownerUserId;
  if (filter.customerProfileId) where.customerProfileId = filter.customerProfileId;

  if (!filter.archived || filter.archived === "exclude") where.archivedAt = null;
  else if (filter.archived === "only") where.archivedAt = { not: null };

  if (filter.search && filter.search.trim().length > 0) {
    const term = filter.search.trim();
    where.OR = [
      { title: { contains: term, mode: "insensitive" } },
      {
        customerProfile: {
          OR: [
            { displayName: { contains: term, mode: "insensitive" } },
            { companyName: { contains: term, mode: "insensitive" } },
          ],
        },
      },
    ];
  }

  const opportunities = await prisma.opportunity.findMany({
    where,
    include: {
      ...opportunityListInclude,
      tasks: {
        where: { status: { in: ["OPEN", "IN_PROGRESS", "WAITING"] } },
        orderBy: { dueAt: "asc" },
        take: 1,
        select: { id: true, title: true, dueAt: true },
      },
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: 200,
  });

  return attachFollowUpFlags(opportunities);
}

export async function listOpportunitiesForCustomer(customerProfileId: string, opts: { archived?: "exclude" | "only" | "all" } = {}) {
  return listOpportunities({ customerProfileId, status: "ALL", archived: opts.archived ?? "exclude" });
}

/** Command-palette opportunity search (build spec §4/architecture doc §16).
 * No RBAC beyond the route's own requireUser() — read-only, same as the
 * existing customer/order/quote search groups. */
export async function searchOpportunities(term: string, limit = 8) {
  return prisma.opportunity.findMany({
    where: {
      archivedAt: null,
      OR: [
        { title: { contains: term, mode: "insensitive" } },
        {
          customerProfile: {
            OR: [
              { displayName: { contains: term, mode: "insensitive" } },
              { companyName: { contains: term, mode: "insensitive" } },
            ],
          },
        },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: { customerProfile: { select: { id: true, displayName: true, companyName: true } } },
  });
}

// ---------------------------------------------------------------------------
// Update / stage / owner
// ---------------------------------------------------------------------------

export async function updateOpportunity(
  id: string,
  input: {
    title?: string;
    description?: string | null;
    estimatedValue?: string | number | null;
    probability?: number | null;
    expectedCloseDate?: Date | null;
  },
  actor: Actor,
) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id } });
  assertCanModify(opportunity, actor);
  assertNotArchived(opportunity);

  // Pre-production review finding A/3: content fields (title/description/
  // value/probability/expected close) are the deal's commercial facts —
  // these must freeze once the deal is closed, exactly like `stage`
  // already does via changeStage()'s guard, for the same reason (reporting
  // integrity: a closed deal's recorded facts must not silently drift).
  // Owner is deliberately NOT covered by this guard — see assignOwner()'s
  // own comment for why reassignment stays allowed on closed opportunities.
  if (opportunity.status !== "OPEN") {
    throw new OpportunityValidationError("Alleen open verkoopkansen kunnen bewerkt worden — heropen eerst.");
  }

  if (input.title !== undefined) validateTitle(input.title);
  if (input.probability !== undefined) validateProbability(input.probability);
  const estimatedValue = input.estimatedValue !== undefined ? parseMoneyInput(input.estimatedValue, "Geschatte waarde") : undefined;

  const data: Prisma.OpportunityUpdateInput = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.description !== undefined) data.description = input.description?.trim() || null;
  if (input.probability !== undefined) data.probability = input.probability;
  if (input.expectedCloseDate !== undefined) data.expectedCloseDate = input.expectedCloseDate;

  const valueChanged = input.estimatedValue !== undefined;
  if (valueChanged) {
    data.estimatedValue = estimatedValue;
  }

  const otherFieldsChanged =
    input.title !== undefined || input.description !== undefined || input.probability !== undefined || input.expectedCloseDate !== undefined;

  if (!valueChanged && !otherFieldsChanged) return opportunity;

  const updated = await prisma.opportunity.update({ where: { id }, data, include: opportunityListInclude });

  if (valueChanged) {
    await logAudit({
      userId: actor.id,
      action: "opportunity.value_changed",
      entityType: "Opportunity",
      entityId: id,
      metadata: { oldValue: opportunity.estimatedValue?.toString() ?? null, newValue: updated.estimatedValue?.toString() ?? null },
    });
  }
  if (otherFieldsChanged) {
    await logAudit({
      userId: actor.id,
      action: "opportunity.updated",
      entityType: "Opportunity",
      entityId: id,
      metadata: { fields: Object.keys(input) },
    });
  }

  return updated;
}

/** Fase mag alleen wijzigen terwijl status=OPEN (architecture doc §3) —
 * een gesloten opportunity moet eerst expliciet heropend worden. */
export async function changeStage(id: string, newStage: OpportunityStage, actor: Actor) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id } });
  assertCanModify(opportunity, actor);
  assertNotArchived(opportunity);

  if (opportunity.status !== "OPEN") {
    throw new OpportunityValidationError("Alleen open verkoopkansen kunnen van fase wijzigen — heropen eerst.");
  }
  if (opportunity.stage === newStage) return opportunity;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.opportunity.update({ where: { id }, data: { stage: newStage }, include: opportunityListInclude });

    await tx.activity.create({
      data: {
        customerProfileId: result.customerProfileId,
        type: "OPPORTUNITY_STAGE_CHANGED",
        sourceType: "CONTROL_CENTER",
        title: `Fase gewijzigd: ${result.title}`,
        summary: `${STAGE_LABEL[opportunity.stage]} → ${STAGE_LABEL[newStage]}`,
        occurredAt: new Date(),
        actorId: actor.id,
        relatedOpportunityId: result.id,
      },
    });

    return result;
  });

  await logAudit({
    userId: actor.id,
    action: "opportunity.stage_changed",
    entityType: "Opportunity",
    entityId: id,
    metadata: { oldStage: opportunity.stage, newStage },
  });

  return updated;
}

/** Eigenaarwijziging krijgt altijd zijn eigen auditregel (architecture doc
 * §12) — eigenaarschap heeft directe verantwoordelijkheidsimplicaties.
 *
 * Deliberately NOT guarded by status=OPEN (unlike updateOpportunity's
 * content fields / changeStage) — pre-production review decision: who owns
 * a deal is an administrative/accountability fact, not one of the deal's
 * commercial facts that must freeze at close for reporting integrity.
 * Reassigning a WON/LOST opportunity (e.g. correcting a wrong owner,
 * handling a personnel change, transferring commission credit) is a
 * legitimate, common real-world need and doesn't affect what was actually
 * sold, for how much, or when — so it stays allowed on any status other
 * than archived. */
export async function assignOwner(id: string, newOwnerUserId: string, actor: Actor) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id } });
  assertCanModify(opportunity, actor);
  assertNotArchived(opportunity);
  await assertUserExistsAndActive(newOwnerUserId, "Eigenaar");

  if (opportunity.ownerUserId === newOwnerUserId) return opportunity;

  const updated = await prisma.opportunity.update({
    where: { id },
    data: { ownerUserId: newOwnerUserId },
    include: opportunityListInclude,
  });

  await logAudit({
    userId: actor.id,
    action: "opportunity.owner_changed",
    entityType: "Opportunity",
    entityId: id,
    metadata: { oldOwnerUserId: opportunity.ownerUserId, newOwnerUserId },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Won / Lost / Reopen / Archive
// ---------------------------------------------------------------------------

export async function markWon(id: string, input: { finalValue?: string | number | null }, actor: Actor) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id } });
  assertCanModify(opportunity, actor);
  assertNotArchived(opportunity);
  if (opportunity.status === "WON") return opportunity; // idempotent no-op, no duplicate audit/Activity
  // Pre-production review finding A/2: WON may only be entered from OPEN —
  // a LOST opportunity must go through reopen() first, exactly like
  // changeStage() already requires. Prevents a direct LOST->WON transition
  // that would silently skip the explicit reopen step (and its own
  // audit/Activity record).
  if (opportunity.status !== "OPEN") {
    throw new OpportunityValidationError("Alleen open verkoopkansen kunnen gewonnen worden — heropen eerst.");
  }

  const explicitFinalValue = input.finalValue !== undefined ? parseMoneyInput(input.finalValue, "Definitieve waarde") : null;
  const now = new Date();
  const finalValue = explicitFinalValue ?? opportunity.estimatedValue;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.opportunity.update({
      where: { id },
      data: { status: "WON", wonAt: now, lostAt: null, lostReason: null, finalValue },
      include: opportunityListInclude,
    });

    await tx.activity.create({
      data: {
        customerProfileId: result.customerProfileId,
        type: "OPPORTUNITY_WON",
        sourceType: "CONTROL_CENTER",
        title: `Verkoopkans gewonnen: ${result.title}`,
        occurredAt: now,
        actorId: actor.id,
        relatedOpportunityId: result.id,
      },
    });

    return result;
  });

  await logAudit({
    userId: actor.id,
    action: "opportunity.won",
    entityType: "Opportunity",
    entityId: id,
    metadata: { finalValue: updated.finalValue?.toString() ?? null },
  });

  return updated;
}

export async function markLost(id: string, input: { lostReason: string }, actor: Actor) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id } });
  assertCanModify(opportunity, actor);
  assertNotArchived(opportunity);

  const lostReason = input.lostReason?.trim() ?? "";
  if (lostReason.length === 0) throw new OpportunityValidationError("Reden van verlies is verplicht.");
  if (lostReason.length > 500) throw new OpportunityValidationError("Reden van verlies is te lang (max 500 tekens).");

  if (opportunity.status === "LOST") return opportunity; // idempotent no-op, no duplicate audit/Activity
  // Pre-production review finding A/2: symmetric to markWon() — LOST may
  // only be entered from OPEN, never directly from WON.
  if (opportunity.status !== "OPEN") {
    throw new OpportunityValidationError("Alleen open verkoopkansen kunnen verloren gaan — heropen eerst.");
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.opportunity.update({
      // finalValue: null is defense-in-depth here — reopen() now already
      // clears it (finding A/1) and the OPEN-only guard above means a WON
      // opportunity can never reach this branch directly, so finalValue is
      // already null in every currently-reachable path. Kept explicit so
      // this stays true even if a future change ever weakens either guard.
      where: { id },
      data: { status: "LOST", lostAt: now, wonAt: null, finalValue: null, lostReason },
      include: opportunityListInclude,
    });

    await tx.activity.create({
      data: {
        customerProfileId: result.customerProfileId,
        type: "OPPORTUNITY_LOST",
        sourceType: "CONTROL_CENTER",
        title: `Verkoopkans verloren: ${result.title}`,
        summary: result.lostReason,
        occurredAt: now,
        actorId: actor.id,
        relatedOpportunityId: result.id,
      },
    });

    return result;
  });

  await logAudit({
    userId: actor.id,
    action: "opportunity.lost",
    entityType: "Opportunity",
    entityId: id,
    metadata: { lostReason: updated.lostReason },
  });

  return updated;
}

/** Status → OPEN. stage is left untouched (frozen value, ADR-009 §1,
 * architecture doc §3).
 *
 * Pre-production review finding A/1 — corrected from the original design:
 * wonAt/lostAt/finalValue are now ALSO cleared (not just lostReason). The
 * Opportunity row always represents CURRENT canonical state; the earlier
 * "sticky" design (keep wonAt/lostAt as history) was found to let a
 * reopened-then-still-open deal keep a non-null wonAt/lostAt, which a
 * naive future report (`WHERE wonAt IS NOT NULL`) would misread as
 * "currently won" — and independently, finalValue was never cleared by
 * markLost() either, so a WON -> reopen -> LOST deal could keep a stale
 * WON-era finalValue. Full historical record of every won/lost/reopened
 * event is preserved unconditionally via AuditEvent (opportunity.won/
 * .lost/.reopened) and Activity (OPPORTUNITY_WON/_LOST/_REOPENED) — those
 * writes never depended on wonAt/lostAt staying populated, so nothing is
 * lost by clearing them here. */
export async function reopen(id: string, actor: Actor) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id } });
  assertCanModify(opportunity, actor);
  assertNotArchived(opportunity);
  if (opportunity.status === "OPEN") return opportunity;

  const previousStatus = opportunity.status;
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.opportunity.update({
      where: { id },
      data: { status: "OPEN", wonAt: null, lostAt: null, lostReason: null, finalValue: null },
      include: opportunityListInclude,
    });

    await tx.activity.create({
      data: {
        customerProfileId: result.customerProfileId,
        type: "OPPORTUNITY_REOPENED",
        sourceType: "CONTROL_CENTER",
        title: `Verkoopkans heropend: ${result.title}`,
        occurredAt: new Date(),
        actorId: actor.id,
        relatedOpportunityId: result.id,
      },
    });

    return result;
  });

  await logAudit({
    userId: actor.id,
    action: "opportunity.reopened",
    entityType: "Opportunity",
    entityId: id,
    metadata: { previousStatus },
  });

  return updated;
}

/** Soft-close only — never a hard delete (ADR-009 §7). Archiving is
 * intentionally allowed regardless of status (open, won, or lost). */
export async function archiveOpportunity(id: string, actor: Actor) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id } });
  assertCanModify(opportunity, actor);
  if (opportunity.archivedAt) return opportunity;

  const updated = await prisma.opportunity.update({
    where: { id },
    data: { archivedAt: new Date() },
    include: opportunityListInclude,
  });

  await logAudit({ userId: actor.id, action: "opportunity.archived", entityType: "Opportunity", entityId: id });
  return updated;
}

// ---------------------------------------------------------------------------
// External links — lightweight references only (ADR-009 §4)
// ---------------------------------------------------------------------------

// Verified against the customer's own Shopify orders/draft orders (up to
// this page size) before a SHOPIFY_ORDER/SHOPIFY_DRAFT_ORDER link is ever
// stored — pre-production review finding E/6. Larger than the UI's own
// default (20) specifically to reduce false rejections for customers with
// a longer order history; a customer with more than this many orders/draft
// orders could still, in a pathological case, have a genuinely-own,
// genuinely-older document rejected — a known, documented limitation of
// reusing the existing paginated adapter rather than building new
// unbounded Shopify lookup logic for this check.
const SHOPIFY_LINK_VERIFICATION_PAGE_SIZE = 250;

/** Confirms externalRef actually belongs to the given Shopify customer
 * before a SHOPIFY_ORDER/SHOPIFY_DRAFT_ORDER link is persisted — reuses
 * the existing, already-hardened read adapters (no new Shopify
 * integration surface, no local copy of the order/draft-order itself).
 * Deliberately does not catch adapter errors: a Shopify outage must fail
 * this check closed (reject the link), not open, matching how
 * Shopify-critical-path failures already propagate elsewhere in this app
 * (e.g. getCustomer360). */
async function assertShopifyDocumentBelongsToCustomer(
  linkType: Extract<OpportunityLinkType, "SHOPIFY_ORDER" | "SHOPIFY_DRAFT_ORDER">,
  externalRef: string,
  customerProfileId: string,
) {
  const customer = await prisma.customerProfile.findUniqueOrThrow({
    where: { id: customerProfileId },
    select: { shopifyCustomerGid: true },
  });

  const belongsToCustomer =
    linkType === "SHOPIFY_ORDER"
      ? (await getShopifyCustomerOrders(customer.shopifyCustomerGid, SHOPIFY_LINK_VERIFICATION_PAGE_SIZE)).orders.some(
          (order) => order.gid === externalRef,
        )
      : (await getShopifyCustomerDraftOrders(customer.shopifyCustomerGid, SHOPIFY_LINK_VERIFICATION_PAGE_SIZE)).draftOrders.some(
          (draftOrder) => draftOrder.gid === externalRef,
        );

  if (!belongsToCustomer) {
    throw new OpportunityValidationError(
      "Dit Shopify-document bestaat niet of hoort niet bij de klant van deze verkoopkans.",
    );
  }
}

export async function addExternalLink(
  opportunityId: string,
  input: { linkType: OpportunityLinkType; externalRef: string },
  actor: Actor,
) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
  assertCanModify(opportunity, actor);
  assertNotArchived(opportunity);

  const externalRef = input.externalRef?.trim() ?? "";
  if (externalRef.length === 0) throw new OpportunityValidationError("Externe referentie is verplicht.");

  // Pre-production review finding E/6: for the two Shopify-backed link
  // types, verify the document actually belongs to this opportunity's
  // customer before it can ever be linked — a crafted API request must
  // never be able to attach customer B's order to customer A's
  // opportunity just because the caller already has write access to A's
  // opportunity. OFFERTEAPP_QUOTE/S4U_QUOTE_APP_QUOTE are NOT covered yet
  // (documented limitation, see ADR-009 §13 — would need a sibling-API
  // single-quote lookup that isn't exposed today).
  if (input.linkType === "SHOPIFY_ORDER" || input.linkType === "SHOPIFY_DRAFT_ORDER") {
    await assertShopifyDocumentBelongsToCustomer(input.linkType, externalRef, opportunity.customerProfileId);
  }

  const link = await prisma.opportunityExternalLink.upsert({
    where: { opportunityId_linkType_externalRef: { opportunityId, linkType: input.linkType, externalRef } },
    create: { opportunityId, linkType: input.linkType, externalRef, linkedById: actor.id },
    update: { unlinkedAt: null, linkedById: actor.id, linkedAt: new Date() },
    include: { linkedBy: { select: { id: true, name: true } } },
  });

  await logAudit({
    userId: actor.id,
    action: "opportunity.external_link_added",
    entityType: "OpportunityExternalLink",
    entityId: link.id,
    metadata: { opportunityId, linkType: input.linkType, externalRef },
  });

  return link;
}

/** IDOR-safe: verifies the link actually belongs to the given opportunity
 * before touching it (security doc §21). */
export async function removeExternalLink(opportunityId: string, linkId: string, actor: Actor) {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
  assertCanModify(opportunity, actor);
  assertNotArchived(opportunity);

  const link = await prisma.opportunityExternalLink.findUniqueOrThrow({ where: { id: linkId } });
  if (link.opportunityId !== opportunityId) {
    throw new OpportunityValidationError("Deze koppeling hoort niet bij deze verkoopkans.");
  }

  const updated = await prisma.opportunityExternalLink.update({ where: { id: linkId }, data: { unlinkedAt: new Date() } });

  await logAudit({
    userId: actor.id,
    action: "opportunity.external_link_removed",
    entityType: "OpportunityExternalLink",
    entityId: linkId,
    metadata: { opportunityId, linkType: link.linkType, externalRef: link.externalRef },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Cross-module invariant helper (ADR-009 §5)
// ---------------------------------------------------------------------------

/** The one place Task/Note/Appointment/File services resolve
 * customerProfileId when an opportunityId is supplied — always derived
 * from the opportunity, never trusted from caller input. Throws (via
 * findUniqueOrThrow, mapped to 404 by toErrorResponse) if the opportunity
 * doesn't exist. */
export async function resolveCustomerProfileIdForOpportunity(opportunityId: string): Promise<string> {
  const opportunity = await prisma.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    select: { customerProfileId: true },
  });
  return opportunity.customerProfileId;
}

import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import { normalizeDutchPhone } from "@/lib/phone";
import { normalizeEmail } from "@/lib/email";
import type { MatchSource, MatchMethod, Role } from "@/generated/prisma";

// Central customer-matching layer (docs/architecture/ADR-007-CUSTOMER-MATCHING-LAYER.md).
// Every Phase 3 adapter (telephony, email, quotes) calls these functions
// instead of writing its own matching logic — the whole point of this
// module existing is that Phase 3b/3c never re-introduce the kind of
// per-path normalization inconsistency found in TelefoonSysteem
// (docs/platform-discovery/22 §2). Production-grade now even though no
// adapter produces real external refs yet in Phase 3a (build spec §1) —
// this is the foundation, not a placeholder.

type Actor = { id: string; role: Role };

export type MatchResolution =
  | { status: "unmatched" }
  | { status: "exact"; customerProfileId: string; matchId: string }
  | { status: "ambiguous"; candidateCustomerProfileIds: string[] };

/** Looks up CustomerProfile candidates for a raw phone number and records
 * the result as ExternalContactMatch row(s) — never returns/exposes an
 * AMBIGUOUS result as usable data (ADR-007 rule 2); callers must resolve
 * ambiguity via confirmMatch() before treating it as a real match. */
export async function resolveAndRecordByPhone(
  phoneRaw: string,
  source: MatchSource,
  externalRef: string,
): Promise<MatchResolution> {
  const normalized = normalizeDutchPhone(phoneRaw);
  if (!normalized) return { status: "unmatched" };
  const candidates = await prisma.customerProfile.findMany({
    where: { phoneNormalized: normalized },
    select: { id: true },
  });
  return recordCandidates(candidates.map((c) => c.id), source, externalRef, "PHONE");
}

/** Same as resolveAndRecordByPhone, keyed on email instead. */
export async function resolveAndRecordByEmail(
  emailRaw: string,
  source: MatchSource,
  externalRef: string,
): Promise<MatchResolution> {
  const normalized = normalizeEmail(emailRaw);
  if (!normalized) return { status: "unmatched" };
  const candidates = await prisma.customerProfile.findMany({
    where: { email: { equals: normalized, mode: "insensitive" } },
    select: { id: true },
  });
  return recordCandidates(candidates.map((c) => c.id), source, externalRef, "EMAIL");
}

async function recordCandidates(
  customerProfileIds: string[],
  source: MatchSource,
  externalRef: string,
  matchedBy: MatchMethod,
): Promise<MatchResolution> {
  if (customerProfileIds.length === 0) return { status: "unmatched" };

  const [soleCandidateId] = customerProfileIds;
  if (soleCandidateId && customerProfileIds.length === 1) {
    const match = await prisma.externalContactMatch.upsert({
      where: { customerProfileId_source_externalRef: { customerProfileId: soleCandidateId, source, externalRef } },
      create: { customerProfileId: soleCandidateId, source, externalRef, matchedBy, confidence: "EXACT" },
      update: {}, // already recorded — do not downgrade an existing (possibly human-confirmed) row
    });
    return { status: "exact", customerProfileId: soleCandidateId, matchId: match.id };
  }

  // Multiple candidates — record every one as AMBIGUOUS, resolved only by
  // a human via confirmMatch(). Never silently pick the first (the exact
  // failure mode ADR-007 calls out in TelefoonSysteem's Exact-history DB
  // and its automatic call-enrichment path).
  await Promise.all(
    customerProfileIds.map((customerProfileId) =>
      prisma.externalContactMatch.upsert({
        where: { customerProfileId_source_externalRef: { customerProfileId, source, externalRef } },
        create: { customerProfileId, source, externalRef, matchedBy, confidence: "AMBIGUOUS" },
        update: {},
      }),
    ),
  );
  return { status: "ambiguous", candidateCustomerProfileIds: customerProfileIds };
}

/** A human confirms a specific match row — either resolving an AMBIGUOUS
 * candidate (upgrades it to MANUAL confidence and unlinks the sibling
 * candidates for the same source+externalRef) or simply co-signing an
 * already-EXACT/LIKELY suggestion (confidence unchanged). */
export async function confirmMatch(matchId: string, actor: Actor) {
  if (actor.role === "VIEWER") throw new ForbiddenError("Alleen schrijfgerechtigde gebruikers mogen een match bevestigen.");

  const match = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: matchId } });

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.externalContactMatch.update({
      where: { id: matchId },
      data: {
        confirmedByUserId: actor.id,
        confidence: match.confidence === "AMBIGUOUS" ? "MANUAL" : match.confidence,
      },
    });

    if (match.confidence === "AMBIGUOUS") {
      await tx.externalContactMatch.updateMany({
        where: {
          source: match.source,
          externalRef: match.externalRef,
          id: { not: matchId },
          confidence: "AMBIGUOUS",
          unlinkedAt: null,
        },
        data: { unlinkedAt: new Date() },
      });
    }

    return result;
  });

  await logAudit({
    userId: actor.id,
    action: "customer_match.confirmed",
    entityType: "ExternalContactMatch",
    entityId: matchId,
    metadata: { source: match.source, customerProfileId: match.customerProfileId },
  });

  return updated;
}

/** A human links a customer to an external reference directly, with no
 * automatic suggestion involved (ADR-007 rule 3). Upserts — re-linking
 * after a prior unlink reactivates the same row rather than duplicating. */
export async function manualLink(
  customerProfileId: string,
  source: MatchSource,
  externalRef: string,
  actor: Actor,
) {
  if (actor.role === "VIEWER") throw new ForbiddenError("Alleen schrijfgerechtigde gebruikers mogen een klant handmatig koppelen.");

  const match = await prisma.externalContactMatch.upsert({
    where: { customerProfileId_source_externalRef: { customerProfileId, source, externalRef } },
    create: { customerProfileId, source, externalRef, matchedBy: "MANUAL", confidence: "MANUAL", confirmedByUserId: actor.id },
    update: { matchedBy: "MANUAL", confidence: "MANUAL", confirmedByUserId: actor.id, unlinkedAt: null },
  });

  await logAudit({
    userId: actor.id,
    action: "customer_match.confirmed",
    entityType: "ExternalContactMatch",
    entityId: match.id,
    metadata: { source, customerProfileId },
  });

  return match;
}

/** Soft-unlink — keeps the row (and its audit trail), hides it from active
 * matching (ADR-007 rule 3). Never a hard delete. */
export async function unlinkMatch(matchId: string, actor: Actor) {
  if (actor.role === "VIEWER") throw new ForbiddenError("Alleen schrijfgerechtigde gebruikers mogen een koppeling verwijderen.");

  const match = await prisma.externalContactMatch.update({
    where: { id: matchId },
    data: { unlinkedAt: new Date() },
  });

  await logAudit({
    userId: actor.id,
    action: "customer_match.unlinked",
    entityType: "ExternalContactMatch",
    entityId: matchId,
    metadata: { source: match.source, customerProfileId: match.customerProfileId },
  });

  return match;
}

/** Active (not unlinked) matches for a customer — used by adapters to
 * check "is there already a confirmed external reference" before
 * re-resolving, and by the (future, 3b/3c) matches UI. */
export async function getMatchesForCustomer(customerProfileId: string) {
  return prisma.externalContactMatch.findMany({
    where: { customerProfileId, unlinkedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

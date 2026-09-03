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

/** Looks up CustomerProfile candidates for a raw phone number (both the
 * profile's own phoneNormalized AND every active CustomerContact's
 * phoneNormalized, Phase 4C — ADR-010 §3) and records the result as
 * ExternalContactMatch row(s) — never returns/exposes an AMBIGUOUS result
 * as usable data (ADR-007 rule 2); callers must resolve ambiguity via
 * confirmMatch() before treating it as a real match. */
export async function resolveAndRecordByPhone(
  phoneRaw: string,
  source: MatchSource,
  externalRef: string,
): Promise<MatchResolution> {
  const normalized = normalizeDutchPhone(phoneRaw);
  if (!normalized) return { status: "unmatched" };
  const [profileCandidates, contactCandidates] = await Promise.all([
    prisma.customerProfile.findMany({ where: { phoneNormalized: normalized }, select: { id: true } }),
    prisma.customerContact.findMany({ where: { phoneNormalized: normalized }, select: { id: true, customerProfileId: true, archivedAt: true } }),
  ]);
  const { customerProfileIds, activeContactIdsByCustomer } = buildCandidateSets(profileCandidates, contactCandidates);
  return recordCandidates(customerProfileIds, activeContactIdsByCustomer, source, externalRef, "PHONE");
}

/** Same as resolveAndRecordByPhone, keyed on email instead. */
export async function resolveAndRecordByEmail(
  emailRaw: string,
  source: MatchSource,
  externalRef: string,
): Promise<MatchResolution> {
  const normalized = normalizeEmail(emailRaw);
  if (!normalized) return { status: "unmatched" };
  const [profileCandidates, contactCandidates] = await Promise.all([
    prisma.customerProfile.findMany({ where: { email: { equals: normalized, mode: "insensitive" } }, select: { id: true } }),
    prisma.customerContact.findMany({ where: { emailNormalized: normalized }, select: { id: true, customerProfileId: true, archivedAt: true } }),
  ]);
  const { customerProfileIds, activeContactIdsByCustomer } = buildCandidateSets(profileCandidates, contactCandidates);
  return recordCandidates(customerProfileIds, activeContactIdsByCustomer, source, externalRef, "EMAIL");
}

/** Merges CustomerProfile-level and CustomerContact-level candidates into
 * one deduplicated customer-candidate set (Phase 4C, ADR-010 §3) — a
 * customer is "found" whether the identity matched the profile's own
 * Shopify-snapshot address/number OR one of its contacts', archived or not
 * (an archived contact's address is still evidence of which CUSTOMER an
 * inbound identity belongs to — ADR-010 §4's "klant blijft bekend"). The
 * separately-tracked activeContactIdsByCustomer map, however, only ever
 * contains NON-archived contacts — an archived contact must never become
 * the automatically-matched *specific person* (build instruction §8
 * scenario E, a deliberate refinement of ADR-010's original wording, see
 * docs/build/PHASE-4C-CONTACTS-STAGING.md). */
function buildCandidateSets(
  profileCandidates: { id: string }[],
  contactCandidates: { id: string; customerProfileId: string; archivedAt: Date | null }[],
): { customerProfileIds: string[]; activeContactIdsByCustomer: Map<string, Set<string>> } {
  const customerProfileIdSet = new Set(profileCandidates.map((c) => c.id));
  const activeContactIdsByCustomer = new Map<string, Set<string>>();

  for (const contact of contactCandidates) {
    customerProfileIdSet.add(contact.customerProfileId);
    if (contact.archivedAt) continue;
    const set = activeContactIdsByCustomer.get(contact.customerProfileId) ?? new Set<string>();
    set.add(contact.id);
    activeContactIdsByCustomer.set(contact.customerProfileId, set);
  }

  return { customerProfileIds: [...customerProfileIdSet], activeContactIdsByCustomer };
}

async function recordCandidates(
  customerProfileIds: string[],
  activeContactIdsByCustomer: Map<string, Set<string>>,
  source: MatchSource,
  externalRef: string,
  matchedBy: MatchMethod,
): Promise<MatchResolution> {
  if (customerProfileIds.length === 0) return { status: "unmatched" };

  const [soleCandidateId] = customerProfileIds;
  if (soleCandidateId && customerProfileIds.length === 1) {
    // Phase 4C — the customer is exact; separately determine whether
    // exactly one active contact matched too (build instruction §8
    // scenarios A/B/C). Two or more active contacts sharing the same
    // identity within this one customer means the PERSON is ambiguous even
    // though the customer isn't — never guess, leave customerContactId null
    // (ADR-010 §4).
    const contactIds = activeContactIdsByCustomer.get(soleCandidateId);
    const resolvedContactId = contactIds && contactIds.size === 1 ? [...contactIds][0]! : null;

    const existing = await prisma.externalContactMatch.findUnique({
      where: { customerProfileId_source_externalRef: { customerProfileId: soleCandidateId, source, externalRef } },
    });

    if (existing) {
      // Never touch a human-confirmed or manually-created row (build
      // instruction §9: "manual/confirmed contact-specific row → niet
      // automatisch overschrijven"), and never overwrite an already-set
      // customerContactId — automatic enrichment is strictly monotonic
      // (null -> set), never destructive/corrective.
      const isHumanOwned = existing.confidence === "MANUAL" || existing.confirmedByUserId !== null;
      const shouldEnrichContact = !isHumanOwned && existing.customerContactId === null && resolvedContactId !== null;
      const match = shouldEnrichContact
        ? await prisma.externalContactMatch.update({ where: { id: existing.id }, data: { customerContactId: resolvedContactId } })
        : existing;
      return { status: "exact", customerProfileId: soleCandidateId, matchId: match.id };
    }

    const match = await prisma.externalContactMatch.create({
      data: { customerProfileId: soleCandidateId, source, externalRef, matchedBy, confidence: "EXACT", customerContactId: resolvedContactId },
    });
    return { status: "exact", customerProfileId: soleCandidateId, matchId: match.id };
  }

  // Multiple candidate customers — record every one as AMBIGUOUS, resolved
  // only by a human via confirmMatch(). Never silently pick the first (the
  // exact failure mode ADR-007 calls out in TelefoonSysteem's Exact-history
  // DB and its automatic call-enrichment path), and never a contact
  // assignment at this level (build instruction §8 scenario D).
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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { resolveAndRecordByPhone, resolveAndRecordByEmail, confirmMatch, manualLink, unlinkMatch, getMatchesForCustomer } from "@/modules/matching/matching.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

// docs/architecture/ADR-007-CUSTOMER-MATCHING-LAYER.md — production-grade
// now even though no Phase 3a adapter produces real external refs yet.

async function createProfileWithContact(overrides: { phone?: string; phoneNormalized?: string; email?: string }) {
  return prisma.customerProfile.create({
    data: {
      shopifyCustomerGid: `gid://shopify/Customer/${crypto.randomUUID()}`,
      displayName: "Matching Test Klant",
      ...overrides,
    },
  });
}

describe("matching.service", () => {
  let agent: { id: string; role: "AGENT" };
  let viewer: { id: string; role: "VIEWER" };
  const userIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    const agentUser = await createTestUser({ role: "AGENT" });
    const viewerUser = await createTestUser({ role: "VIEWER" });
    agent = { id: agentUser.id, role: "AGENT" };
    viewer = { id: viewerUser.id, role: "VIEWER" };
    userIds.push(agentUser.id, viewerUser.id);
  });

  afterAll(async () => {
    for (const id of profileIds) await cleanupCustomerProfile(id);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("resolves an exact phone match to the single candidate and is idempotent on re-resolution", async () => {
    const profile = await createProfileWithContact({ phone: "0612345678", phoneNormalized: "31612345678" });
    profileIds.push(profile.id);

    const first = await resolveAndRecordByPhone("+31612345678", "TELEFOONSYSTEEM", "call-ext-1");
    expect(first).toEqual({ status: "exact", customerProfileId: profile.id, matchId: expect.any(String) });

    const second = await resolveAndRecordByPhone("0612345678", "TELEFOONSYSTEEM", "call-ext-1");
    expect(second.status).toBe("exact");
    if (second.status === "exact") expect(second.matchId).toBe((first as { matchId: string }).matchId); // upsert, not a duplicate row

    const rows = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profile.id, source: "TELEFOONSYSTEEM" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confidence).toBe("EXACT");
  });

  it("resolves an exact email match", async () => {
    const profile = await createProfileWithContact({ email: "unique-match-test@voorbeeld.nl" });
    profileIds.push(profile.id);

    const result = await resolveAndRecordByEmail("Unique-Match-Test@Voorbeeld.NL", "GMAIL", "msg-1");
    expect(result).toEqual({ status: "exact", customerProfileId: profile.id, matchId: expect.any(String) });
  });

  it("returns unmatched and records nothing for a phone number with no candidate", async () => {
    const result = await resolveAndRecordByPhone("0699999999", "TELEFOONSYSTEEM", "call-ext-none");
    expect(result).toEqual({ status: "unmatched" });
    const rows = await prisma.externalContactMatch.findMany({ where: { externalRef: "call-ext-none" } });
    expect(rows).toHaveLength(0);
  });

  it("returns unmatched (never throws) for unparseable input", async () => {
    expect(await resolveAndRecordByPhone("not-a-phone", "TELEFOONSYSTEEM", "x")).toEqual({ status: "unmatched" });
    expect(await resolveAndRecordByEmail("not-an-email", "GMAIL", "x")).toEqual({ status: "unmatched" });
  });

  it("records every candidate as AMBIGUOUS when multiple profiles share a phone number — never silently picks one", async () => {
    const sharedPhone = "0687654321";
    const sharedNormalized = "31687654321";
    const profileA = await createProfileWithContact({ phone: sharedPhone, phoneNormalized: sharedNormalized });
    const profileB = await createProfileWithContact({ phone: sharedPhone, phoneNormalized: sharedNormalized });
    profileIds.push(profileA.id, profileB.id);

    const result = await resolveAndRecordByPhone(sharedPhone, "TELEFOONSYSTEEM", "call-ext-ambiguous");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidateCustomerProfileIds.sort()).toEqual([profileA.id, profileB.id].sort());
    }

    const rows = await prisma.externalContactMatch.findMany({ where: { source: "TELEFOONSYSTEEM", externalRef: "call-ext-ambiguous" } });
    expect(rows.every((r) => r.confidence === "AMBIGUOUS")).toBe(true);
    expect(rows.every((r) => r.confirmedByUserId === null)).toBe(true); // never auto-confirmed
  });

  it("confirmMatch resolves an ambiguous match to MANUAL confidence and unlinks the sibling candidates", async () => {
    const sharedPhone = "0611122233";
    const sharedNormalized = "31611122233";
    const profileA = await createProfileWithContact({ phone: sharedPhone, phoneNormalized: sharedNormalized });
    const profileB = await createProfileWithContact({ phone: sharedPhone, phoneNormalized: sharedNormalized });
    profileIds.push(profileA.id, profileB.id);

    await resolveAndRecordByPhone(sharedPhone, "TELEFOONSYSTEEM", "call-ext-confirm");
    const rows = await prisma.externalContactMatch.findMany({ where: { source: "TELEFOONSYSTEEM", externalRef: "call-ext-confirm" } });
    const chosen = rows.find((r) => r.customerProfileId === profileA.id)!;
    const rejected = rows.find((r) => r.customerProfileId === profileB.id)!;

    const confirmed = await confirmMatch(chosen.id, agent);
    expect(confirmed.confidence).toBe("MANUAL");
    expect(confirmed.confirmedByUserId).toBe(agent.id);

    const rejectedAfter = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: rejected.id } });
    expect(rejectedAfter.unlinkedAt).not.toBeNull();

    const activeMatches = await getMatchesForCustomer(profileB.id);
    expect(activeMatches.some((m) => m.id === rejected.id)).toBe(false); // unlinked, hidden from active matches
  });

  it("manualLink creates a confirmed MANUAL match directly, and is idempotent (upsert)", async () => {
    const profile = await createProfileWithContact({});
    profileIds.push(profile.id);

    const first = await manualLink(profile.id, "OFFERTEAPP", "quote-123", agent);
    expect(first.matchedBy).toBe("MANUAL");
    expect(first.confidence).toBe("MANUAL");
    expect(first.confirmedByUserId).toBe(agent.id);

    const second = await manualLink(profile.id, "OFFERTEAPP", "quote-123", agent);
    expect(second.id).toBe(first.id);

    const rows = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profile.id, source: "OFFERTEAPP" } });
    expect(rows).toHaveLength(1);
  });

  it("unlinkMatch soft-unlinks — row remains for audit, disappears from active matches", async () => {
    const profile = await createProfileWithContact({});
    profileIds.push(profile.id);
    const match = await manualLink(profile.id, "S4U_QUOTE_APP", "quote-456", agent);

    await unlinkMatch(match.id, agent);

    const stillExists = await prisma.externalContactMatch.findUnique({ where: { id: match.id } });
    expect(stillExists).not.toBeNull();
    expect(stillExists?.unlinkedAt).not.toBeNull();

    const active = await getMatchesForCustomer(profile.id);
    expect(active.some((m) => m.id === match.id)).toBe(false);
  });

  it("forbids a VIEWER from confirming, manually linking, or unlinking", async () => {
    const profile = await createProfileWithContact({});
    profileIds.push(profile.id);
    const match = await manualLink(profile.id, "GMAIL", "viewer-test@voorbeeld.nl", agent);

    await expect(manualLink(profile.id, "GMAIL", "other@voorbeeld.nl", viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(confirmMatch(match.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(unlinkMatch(match.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("writes an AuditEvent for confirm/manual-link and for unlink", async () => {
    const profile = await createProfileWithContact({});
    profileIds.push(profile.id);
    const match = await manualLink(profile.id, "TELEFOONSYSTEEM", "audit-ext-1", agent);

    const createdAudit = await prisma.auditEvent.findFirst({
      where: { action: "customer_match.confirmed", entityId: match.id },
    });
    expect(createdAudit).not.toBeNull();

    await unlinkMatch(match.id, agent);
    const unlinkedAudit = await prisma.auditEvent.findFirst({ where: { action: "customer_match.unlinked", entityId: match.id } });
    expect(unlinkedAudit).not.toBeNull();
  });

  it("accepts MatchSource.EMAIL — the provider-independent email matchsource (docs/architecture/ADR-007 correction, doc 30 §6)", async () => {
    const profile = await createProfileWithContact({ email: "email-source-test@voorbeeld.nl" });
    profileIds.push(profile.id);

    const result = await resolveAndRecordByEmail("email-source-test@voorbeeld.nl", "EMAIL", "m365-mailbox-1-msg-1");
    expect(result).toEqual({ status: "exact", customerProfileId: profile.id, matchId: expect.any(String) });

    const rows = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profile.id, source: "EMAIL" } });
    expect(rows).toHaveLength(1);
  });

  it("enforces the (customerProfileId, source, externalRef) uniqueness constraint at the database level", async () => {
    const profile = await createProfileWithContact({});
    profileIds.push(profile.id);
    await manualLink(profile.id, "GMAIL", "uniqueness-test@voorbeeld.nl", agent);

    await expect(
      prisma.externalContactMatch.create({
        data: { customerProfileId: profile.id, source: "GMAIL", externalRef: "uniqueness-test@voorbeeld.nl", matchedBy: "MANUAL", confidence: "MANUAL" },
      }),
    ).rejects.toThrow();
  });
});

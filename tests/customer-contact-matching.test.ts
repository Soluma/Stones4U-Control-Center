import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { resolveAndRecordByEmail, resolveAndRecordByPhone, confirmMatch, manualLink } from "@/modules/matching/matching.service";
import { createContact, archiveContact } from "@/modules/crm/customer-contact.service";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

// Phase 4C matching-layer extension (ADR-010 §3-4, build instruction §7-9).
// Every scenario uses its own fresh customer(s) + a unique externalRef, so
// tests never collide with each other or with other test files running in
// parallel against the same database.

describe("matching.service — Phase 4C contact-aware resolution", () => {
  let agent: { id: string; role: "AGENT" };
  const userIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    const agentUser = await createTestUser({ role: "AGENT" });
    agent = { id: agentUser.id, role: "AGENT" };
    userIds.push(agentUser.id);
  });

  afterAll(async () => {
    for (const id of profileIds) {
      await prisma.externalContactMatch.deleteMany({ where: { customerProfileId: id } });
      await prisma.customerContact.deleteMany({ where: { customerProfileId: id } });
      await cleanupCustomerProfile(id);
    }
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  async function freshCustomer() {
    const profile = await createTestCustomerProfile();
    profileIds.push(profile.id);
    return profile;
  }

  describe("EMAIL", () => {
    it("A. exact unique active contact -> customer exact, customerContactId set to that contact", async () => {
      const profile = await freshCustomer();
      const { contact } = await createContact({ customerProfileId: profile.id, displayName: "Piet de Vries", email: "piet@jansentuinen.nl" }, agent);

      const ref = `piet-a-${crypto.randomUUID()}@jansentuinen.nl`;
      await prisma.customerContact.update({ where: { id: contact.id }, data: { emailNormalized: ref } });

      const result = await resolveAndRecordByEmail(ref, "EMAIL", ref);
      expect(result.status).toBe("exact");
      if (result.status !== "exact") throw new Error("unreachable");
      expect(result.customerProfileId).toBe(profile.id);

      const match = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: result.matchId } });
      expect(match.customerContactId).toBe(contact.id);
    });

    it("B. exact only on CustomerProfile.email (no contact) -> customer exact, customerContactId null", async () => {
      const profile = await createTestCustomerProfile();
      profileIds.push(profile.id);
      const email = `profile-only-${crypto.randomUUID()}@example.com`;
      await prisma.customerProfile.update({ where: { id: profile.id }, data: { email } });

      const result = await resolveAndRecordByEmail(email, "EMAIL", email);
      expect(result.status).toBe("exact");
      if (result.status !== "exact") throw new Error("unreachable");
      const match = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: result.matchId } });
      expect(match.customerContactId).toBeNull();
    });

    it("C. same identity on two ACTIVE contacts within the SAME customer -> customer exact, customerContactId null (person ambiguous)", async () => {
      const profile = await freshCustomer();
      const sharedEmail = `gedeeld-${crypto.randomUUID()}@bedrijf.nl`;
      const { contact: c1 } = await createContact({ customerProfileId: profile.id, displayName: "Contact Een" }, agent);
      const { contact: c2 } = await createContact({ customerProfileId: profile.id, displayName: "Contact Twee" }, agent);
      await prisma.customerContact.update({ where: { id: c1.id }, data: { emailNormalized: sharedEmail } });
      await prisma.customerContact.update({ where: { id: c2.id }, data: { emailNormalized: sharedEmail } });

      const result = await resolveAndRecordByEmail(sharedEmail, "EMAIL", sharedEmail);
      expect(result.status).toBe("exact");
      if (result.status !== "exact") throw new Error("unreachable");
      expect(result.customerProfileId).toBe(profile.id);
      const match = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: result.matchId } });
      expect(match.customerContactId).toBeNull();
    });

    it("D. same identity across contacts of DIFFERENT customers -> fully ambiguous, never auto-confirmed", async () => {
      const profileA = await freshCustomer();
      const profileB = await freshCustomer();
      const sharedEmail = `cross-customer-${crypto.randomUUID()}@example.com`;
      const { contact: ca } = await createContact({ customerProfileId: profileA.id, displayName: "Klant A Contact" }, agent);
      const { contact: cb } = await createContact({ customerProfileId: profileB.id, displayName: "Klant B Contact" }, agent);
      await prisma.customerContact.update({ where: { id: ca.id }, data: { emailNormalized: sharedEmail } });
      await prisma.customerContact.update({ where: { id: cb.id }, data: { emailNormalized: sharedEmail } });

      const result = await resolveAndRecordByEmail(sharedEmail, "EMAIL", sharedEmail);
      expect(result.status).toBe("ambiguous");
      if (result.status !== "ambiguous") throw new Error("unreachable");
      expect(result.candidateCustomerProfileIds.sort()).toEqual([profileA.id, profileB.id].sort());

      const matches = await prisma.externalContactMatch.findMany({ where: { source: "EMAIL", externalRef: sharedEmail } });
      expect(matches.every((m) => m.confidence === "AMBIGUOUS")).toBe(true);
      expect(matches.every((m) => m.customerContactId === null)).toBe(true);
    });

    it("E. identity exclusively on an ARCHIVED contact -> customer still resolves exact (identity known), but never auto-matched as the active specific person", async () => {
      const profile = await freshCustomer();
      const { contact } = await createContact({ customerProfileId: profile.id, displayName: "Voormalig Contact" }, agent);
      const ref = `archived-only-${crypto.randomUUID()}@example.com`;
      await prisma.customerContact.update({ where: { id: contact.id }, data: { emailNormalized: ref } });
      await archiveContact(profile.id, contact.id, agent);

      const result = await resolveAndRecordByEmail(ref, "EMAIL", ref);
      expect(result.status).toBe("exact");
      if (result.status !== "exact") throw new Error("unreachable");
      expect(result.customerProfileId).toBe(profile.id);
      const match = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: result.matchId } });
      expect(match.customerContactId).toBeNull();
    });
  });

  describe("PHONE", () => {
    function randomDutchMobile(): string {
      return `06${Math.floor(10000000 + Math.random() * 89999999)}`;
    }

    it("A. exact unique active contact phone -> customerContactId set", async () => {
      const profile = await freshCustomer();
      const { contact } = await createContact({ customerProfileId: profile.id, displayName: "Telefoon Contact" }, agent);
      const raw = randomDutchMobile();
      const ref = `31${raw.slice(1)}`;
      await prisma.customerContact.update({ where: { id: contact.id }, data: { phoneNormalized: ref } });

      const result = await resolveAndRecordByPhone(raw, "TELEFOONSYSTEEM", ref);
      expect(result.status).toBe("exact");
      if (result.status !== "exact") throw new Error("unreachable");
      const match = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: result.matchId } });
      expect(match.customerContactId).toBe(contact.id);
    });

    it("customer-only phone (no contact) -> exact, customerContactId null", async () => {
      const profile = await createTestCustomerProfile();
      profileIds.push(profile.id);
      const raw = randomDutchMobile();
      const ref = `31${raw.slice(1)}`;
      await prisma.customerProfile.update({ where: { id: profile.id }, data: { phoneNormalized: ref } });

      const result = await resolveAndRecordByPhone(raw, "TELEFOONSYSTEEM", ref);
      expect(result.status).toBe("exact");
      if (result.status !== "exact") throw new Error("unreachable");
      const match = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: result.matchId } });
      expect(match.customerContactId).toBeNull();
    });
  });

  describe("existing rows — never overwritten (build instruction §9)", () => {
    it("enriches an existing customer-only automatic match with a contact once one becomes exactly resolvable", async () => {
      const profile = await freshCustomer();
      const email = `enrich-${crypto.randomUUID()}@example.com`;
      await prisma.customerProfile.update({ where: { id: profile.id }, data: { email } });

      const firstResult = await resolveAndRecordByEmail(email, "EMAIL", email);
      if (firstResult.status !== "exact") throw new Error("unreachable");
      const before = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: firstResult.matchId } });
      expect(before.customerContactId).toBeNull();

      // A contact with this exact email now gets added after the fact.
      const { contact } = await createContact({ customerProfileId: profile.id, displayName: "Later Toegevoegd" }, agent);
      await prisma.customerContact.update({ where: { id: contact.id }, data: { emailNormalized: email } });

      const secondResult = await resolveAndRecordByEmail(email, "EMAIL", email);
      if (secondResult.status !== "exact") throw new Error("unreachable");
      const after = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: secondResult.matchId } });
      expect(after.customerContactId).toBe(contact.id);
      expect(secondResult.matchId).toBe(firstResult.matchId); // same row, enriched in place
    });

    it("never overwrites a human-confirmed row's customerContactId, even if a different contact would now resolve", async () => {
      const profile = await freshCustomer();
      const email = `confirmed-${crypto.randomUUID()}@example.com`;
      const { contact: contactX } = await createContact({ customerProfileId: profile.id, displayName: "Contact X" }, agent);
      await prisma.customerContact.update({ where: { id: contactX.id }, data: { emailNormalized: email } });

      const result = await resolveAndRecordByEmail(email, "EMAIL", email);
      if (result.status !== "exact") throw new Error("unreachable");
      // Human confirms the system suggestion.
      await confirmMatch(result.matchId, agent);
      const confirmed = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: result.matchId } });
      expect(confirmed.customerContactId).toBe(contactX.id);

      // Archive X and add a different contact Y with the SAME email — automatic
      // re-resolution must not silently move the confirmed row to point at Y.
      await archiveContact(profile.id, contactX.id, agent);
      const { contact: contactY } = await createContact({ customerProfileId: profile.id, displayName: "Contact Y" }, agent);
      await prisma.customerContact.update({ where: { id: contactY.id }, data: { emailNormalized: email } });

      await resolveAndRecordByEmail(email, "EMAIL", email);
      const stillConfirmed = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: result.matchId } });
      expect(stillConfirmed.customerContactId).toBe(contactX.id); // unchanged
      expect(stillConfirmed.confirmedByUserId).toBe(agent.id);
    });

    it("never touches a MANUAL row's customerContactId via automatic re-resolution", async () => {
      const profile = await freshCustomer();
      const email = `manual-${crypto.randomUUID()}@example.com`;
      const manual = await manualLink(profile.id, "EMAIL", email, agent);
      expect(manual.customerContactId).toBeNull();
      expect(manual.confidence).toBe("MANUAL");

      const { contact } = await createContact({ customerProfileId: profile.id, displayName: "Zou Kunnen Matchen" }, agent);
      await prisma.customerContact.update({ where: { id: contact.id }, data: { emailNormalized: email } });

      await resolveAndRecordByEmail(email, "EMAIL", email);
      const stillManual = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: manual.id } });
      expect(stillManual.customerContactId).toBeNull();
      expect(stillManual.confidence).toBe("MANUAL");
    });

    it("repeated resolution never regresses an already-set customerContactId back to null", async () => {
      const profile = await freshCustomer();
      const email = `stable-${crypto.randomUUID()}@example.com`;
      const { contact } = await createContact({ customerProfileId: profile.id, displayName: "Stabiel Contact" }, agent);
      await prisma.customerContact.update({ where: { id: contact.id }, data: { emailNormalized: email } });

      const first = await resolveAndRecordByEmail(email, "EMAIL", email);
      const second = await resolveAndRecordByEmail(email, "EMAIL", email);
      if (first.status !== "exact" || second.status !== "exact") throw new Error("unreachable");

      const match = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: second.matchId } });
      expect(match.customerContactId).toBe(contact.id);
    });
  });

  describe("regression — pre-existing customer-level matching semantics unchanged", () => {
    it("unmatched when no candidate exists at all", async () => {
      const result = await resolveAndRecordByEmail(`nowhere-${crypto.randomUUID()}@example.com`, "EMAIL", "irrelevant");
      expect(result.status).toBe("unmatched");
    });

    it("unmatched for an unparseable email/phone (never throws)", async () => {
      expect((await resolveAndRecordByEmail("not-an-email", "EMAIL", "x")).status).toBe("unmatched");
      expect((await resolveAndRecordByPhone("abc", "TELEFOONSYSTEEM", "x")).status).toBe("unmatched");
    });
  });
});

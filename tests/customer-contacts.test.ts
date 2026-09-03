import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import {
  createContact,
  updateContact,
  archiveContact,
  restoreContact,
  listContactsForCustomer,
  searchCustomerContacts,
  assertContactBelongsToCustomer,
  CustomerContactValidationError,
} from "@/modules/crm/customer-contact.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

async function hardCleanupContacts(customerProfileId: string) {
  await prisma.externalContactMatch.deleteMany({ where: { customerProfileId } });
  await prisma.customerContact.deleteMany({ where: { customerProfileId } });
}

describe("customer-contact.service", () => {
  let agent: { id: string; role: "AGENT" };
  let admin: { id: string; role: "ADMIN" };
  let viewer: { id: string; role: "VIEWER" };
  let customerProfileId: string;
  let otherCustomerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const agentUser = await createTestUser({ role: "AGENT" });
    const adminUser = await createTestUser({ role: "ADMIN" });
    const viewerUser = await createTestUser({ role: "VIEWER" });
    const profile = await createTestCustomerProfile();
    const otherProfile = await createTestCustomerProfile();

    agent = { id: agentUser.id, role: "AGENT" };
    admin = { id: adminUser.id, role: "ADMIN" };
    viewer = { id: viewerUser.id, role: "VIEWER" };
    customerProfileId = profile.id;
    otherCustomerProfileId = otherProfile.id;
    userIds.push(agentUser.id, adminUser.id, viewerUser.id);
  });

  afterAll(async () => {
    await hardCleanupContacts(customerProfileId);
    await hardCleanupContacts(otherCustomerProfileId);
    await cleanupCustomerProfile(customerProfileId);
    await cleanupCustomerProfile(otherCustomerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  describe("CRUD", () => {
    it("creates a contact with only a name (email/phone optional)", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Alleen Naam" }, agent);
      expect(contact.displayName).toBe("Alleen Naam");
      expect(contact.email).toBeNull();
      expect(contact.phone).toBeNull();

      const audit = await prisma.auditEvent.findFirst({ where: { entityId: contact.id, action: "customer_contact.created" } });
      expect(audit).not.toBeNull();
    });

    it("rejects an empty/whitespace-only name", async () => {
      await expect(createContact({ customerProfileId, displayName: "   " }, agent)).rejects.toBeInstanceOf(CustomerContactValidationError);
    });

    it("normalizes a valid email/phone and preserves the raw value", async () => {
      // Deliberately NOT the well-known "0612345678"/"31612345678" fixture
      // literal used by tests/matching.test.ts and others — the Phase 4C
      // matching-layer extension now also searches CustomerContact.phoneNormalized,
      // so a shared literal here would leak into those tests as an extra
      // ambiguous candidate when both files run in parallel against the same
      // database (found and fixed the hard way — see the fixtures.ts
      // displayName randomization from the Phase 4B round for the same class
      // of bug).
      const uniquePhoneSuffix = Math.floor(10000000 + Math.random() * 89999999);
      const { contact } = await createContact(
        { customerProfileId, displayName: "Jan Jansen", email: "  Jan@Jansentuinen.NL  ", phone: `06-${uniquePhoneSuffix}` },
        agent,
      );
      expect(contact.email).toBe("Jan@Jansentuinen.NL");
      expect(contact.emailNormalized).toBe("jan@jansentuinen.nl");
      expect(contact.phone).toBe(`06-${uniquePhoneSuffix}`);
      expect(contact.phoneNormalized).toBe(`316${uniquePhoneSuffix}`);
    });

    it("rejects a non-empty but invalid email/phone", async () => {
      await expect(createContact({ customerProfileId, displayName: "Test", email: "not-an-email" }, agent)).rejects.toBeInstanceOf(
        CustomerContactValidationError,
      );
      await expect(createContact({ customerProfileId, displayName: "Test", phone: "abc" }, agent)).rejects.toBeInstanceOf(
        CustomerContactValidationError,
      );
    });

    it("treats an empty string as null (no error)", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Leeg", email: "", phone: "" }, agent);
      expect(contact.email).toBeNull();
      expect(contact.phone).toBeNull();
    });

    it("updates a contact and recalculates normalization", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Update-test", email: "old@example.com" }, agent);
      const { contact: updated } = await updateContact(customerProfileId, contact.id, { email: "New@Example.com" }, agent);
      expect(updated.emailNormalized).toBe("new@example.com");

      const audit = await prisma.auditEvent.findFirst({ where: { entityId: contact.id, action: "customer_contact.updated" } });
      expect(audit).not.toBeNull();
    });

    it("archives and restores a contact, writing the correct audit actions", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Archief-test" }, agent);
      const archived = await archiveContact(customerProfileId, contact.id, agent);
      expect(archived.archivedAt).not.toBeNull();

      const archivedAudit = await prisma.auditEvent.findFirst({ where: { entityId: contact.id, action: "customer_contact.archived" } });
      expect(archivedAudit).not.toBeNull();

      const restored = await restoreContact(customerProfileId, contact.id, agent);
      expect(restored.archivedAt).toBeNull();

      const restoredAudit = await prisma.auditEvent.findFirst({ where: { entityId: contact.id, action: "customer_contact.restored" } });
      expect(restoredAudit).not.toBeNull();
    });

    it("archive/restore are idempotent — no duplicate audit rows on repeat calls", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Idempotent-test" }, agent);
      await archiveContact(customerProfileId, contact.id, agent);
      await archiveContact(customerProfileId, contact.id, agent);
      const archivedCount = await prisma.auditEvent.count({ where: { entityId: contact.id, action: "customer_contact.archived" } });
      expect(archivedCount).toBe(1);

      await restoreContact(customerProfileId, contact.id, agent);
      await restoreContact(customerProfileId, contact.id, agent);
      const restoredCount = await prisma.auditEvent.count({ where: { entityId: contact.id, action: "customer_contact.restored" } });
      expect(restoredCount).toBe(1);
    });
  });

  describe("primary contact", () => {
    it("sets the first contact as primary and writes a primary_changed audit", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Eerste Primair", isPrimary: true }, agent);
      expect(contact.isPrimary).toBe(true);
      const audit = await prisma.auditEvent.findFirst({ where: { entityId: contact.id, action: "customer_contact.primary_changed" } });
      expect(audit).not.toBeNull();
    });

    it("switching primary to a second contact automatically unsets the first, within one operation", async () => {
      const { contact: first } = await createContact({ customerProfileId, displayName: "Was Primair", isPrimary: true }, agent);
      const { contact: second } = await createContact({ customerProfileId, displayName: "Wordt Primair", isPrimary: true }, agent);

      const refreshedFirst = await prisma.customerContact.findUniqueOrThrow({ where: { id: first.id } });
      expect(refreshedFirst.isPrimary).toBe(false);
      expect(second.isPrimary).toBe(true);

      const activeCount = await prisma.customerContact.count({ where: { customerProfileId, isPrimary: true, archivedAt: null } });
      expect(activeCount).toBe(1);
    });

    it("updateContact({isPrimary: true}) switches primary the same way", async () => {
      const { contact: a } = await createContact({ customerProfileId, displayName: "A", isPrimary: true }, agent);
      const { contact: b } = await createContact({ customerProfileId, displayName: "B" }, agent);

      await updateContact(customerProfileId, b.id, { isPrimary: true }, agent);
      const refreshedA = await prisma.customerContact.findUniqueOrThrow({ where: { id: a.id } });
      expect(refreshedA.isPrimary).toBe(false);
    });

    it("archiving the current primary contact clears isPrimary and does not auto-promote another contact", async () => {
      const { contact: primary } = await createContact({ customerProfileId, displayName: "Primair-archief-test", isPrimary: true }, agent);
      await createContact({ customerProfileId, displayName: "Andere Contact" }, agent);

      const archived = await archiveContact(customerProfileId, primary.id, agent);
      expect(archived.isPrimary).toBe(false);

      const activePrimaryCount = await prisma.customerContact.count({ where: { customerProfileId, isPrimary: true, archivedAt: null } });
      expect(activePrimaryCount).toBe(0);
    });

    it("restoring a contact never auto-sets isPrimary again", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Restore-primary-test", isPrimary: true }, agent);
      await archiveContact(customerProfileId, contact.id, agent);
      const restored = await restoreContact(customerProfileId, contact.id, agent);
      expect(restored.isPrimary).toBe(false);
    });

    it("never allows two active primary contacts for the same customer under concurrent create calls (DB invariant)", async () => {
      const isolatedProfile = await createTestCustomerProfile();
      try {
        const results = await Promise.allSettled([
          createContact({ customerProfileId: isolatedProfile.id, displayName: "Race A", isPrimary: true }, agent),
          createContact({ customerProfileId: isolatedProfile.id, displayName: "Race B", isPrimary: true }, agent),
        ]);

        // Every settled outcome must be either a success or our own clean
        // validation error — never an unhandled exception type.
        for (const result of results) {
          if (result.status === "rejected") {
            expect(result.reason).toBeInstanceOf(CustomerContactValidationError);
          }
        }

        const activePrimaryCount = await prisma.customerContact.count({
          where: { customerProfileId: isolatedProfile.id, isPrimary: true, archivedAt: null },
        });
        expect(activePrimaryCount).toBeLessThanOrEqual(1);
      } finally {
        await hardCleanupContacts(isolatedProfile.id);
        await cleanupCustomerProfile(isolatedProfile.id);
      }
    });
  });

  describe("duplicates", () => {
    it("warns (does not block) on a duplicate email within the same customer", async () => {
      await createContact({ customerProfileId, displayName: "Origineel", email: "gedeeld@example.com" }, agent);
      const { contact, duplicateWarning } = await createContact({ customerProfileId, displayName: "Duplicaat", email: "gedeeld@example.com" }, agent);
      expect(contact).toBeTruthy();
      expect(duplicateWarning).toEqual({ field: "email", conflictingContactId: expect.any(String) });
    });

    it("warns on a duplicate phone within the same customer", async () => {
      await createContact({ customerProfileId, displayName: "Origineel Tel", phone: "0612340000" }, agent);
      const { duplicateWarning } = await createContact({ customerProfileId, displayName: "Duplicaat Tel", phone: "0612340000" }, agent);
      expect(duplicateWarning?.field).toBe("phone");
    });

    it("does not warn for the same email at a different customer", async () => {
      await createContact({ customerProfileId, displayName: "Klant A Contact", email: "cross@example.com" }, agent);
      const { duplicateWarning } = await createContact(
        { customerProfileId: otherCustomerProfileId, displayName: "Klant B Contact", email: "cross@example.com" },
        agent,
      );
      expect(duplicateWarning).toBeNull();
    });

    it("does not warn against an archived contact's email", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Wordt Gearchiveerd", email: "archived-dup@example.com" }, agent);
      await archiveContact(customerProfileId, contact.id, agent);
      const { duplicateWarning } = await createContact({ customerProfileId, displayName: "Nieuw", email: "archived-dup@example.com" }, agent);
      expect(duplicateWarning).toBeNull();
    });

    it("excludes the contact's own row when updating (no false self-duplicate)", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Zelf-update", email: "self@example.com" }, agent);
      const { duplicateWarning } = await updateContact(customerProfileId, contact.id, { jobTitle: "Bijgewerkt" }, agent);
      expect(duplicateWarning).toBeNull();
    });
  });

  describe("RBAC", () => {
    it("forbids VIEWER from create/update/archive/restore", async () => {
      await expect(createContact({ customerProfileId, displayName: "Viewer-test" }, viewer)).rejects.toBeInstanceOf(ForbiddenError);

      const { contact } = await createContact({ customerProfileId, displayName: "Voor-viewer-test" }, agent);
      await expect(updateContact(customerProfileId, contact.id, { displayName: "x" }, viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(archiveContact(customerProfileId, contact.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(restoreContact(customerProfileId, contact.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("lets any AGENT (not just the creator) edit a contact — shared directory record, no author restriction", async () => {
      const otherAgentUser = await createTestUser({ role: "AGENT" });
      userIds.push(otherAgentUser.id);
      const otherAgent = { id: otherAgentUser.id, role: "AGENT" as const };

      const { contact } = await createContact({ customerProfileId, displayName: "Gedeeld Contact" }, agent);
      const { contact: updated } = await updateContact(customerProfileId, contact.id, { jobTitle: "Door collega bewerkt" }, otherAgent);
      expect(updated.jobTitle).toBe("Door collega bewerkt");
    });

    it("lets ADMIN perform every mutation", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Admin-test" }, admin);
      await updateContact(customerProfileId, contact.id, { jobTitle: "Beheerder-bewerkt" }, admin);
      await archiveContact(customerProfileId, contact.id, admin);
      await restoreContact(customerProfileId, contact.id, admin);
    });
  });

  describe("IDOR", () => {
    it("blocks updating a contact belonging to a different customer than the URL/route customerProfileId", async () => {
      const { contact } = await createContact({ customerProfileId: otherCustomerProfileId, displayName: "Klant B" }, agent);
      await expect(updateContact(customerProfileId, contact.id, { displayName: "Gehackt" }, agent)).rejects.toThrow();
    });

    it("blocks archiving a contact belonging to a different customer", async () => {
      const { contact } = await createContact({ customerProfileId: otherCustomerProfileId, displayName: "Klant B Archief" }, agent);
      await expect(archiveContact(customerProfileId, contact.id, agent)).rejects.toThrow();
    });

    it("blocks restoring a contact belonging to a different customer", async () => {
      const { contact } = await createContact({ customerProfileId: otherCustomerProfileId, displayName: "Klant B Restore" }, agent);
      await archiveContact(otherCustomerProfileId, contact.id, agent);
      await expect(restoreContact(customerProfileId, contact.id, agent)).rejects.toThrow();
    });

    it("assertContactBelongsToCustomer rejects a cross-customer contact", async () => {
      const { contact } = await createContact({ customerProfileId: otherCustomerProfileId, displayName: "Klant B Assert" }, agent);
      await expect(assertContactBelongsToCustomer(contact.id, customerProfileId)).rejects.toBeInstanceOf(CustomerContactValidationError);
    });

    it("assertContactBelongsToCustomer succeeds for a same-customer contact", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Klant A Assert" }, agent);
      await expect(assertContactBelongsToCustomer(contact.id, customerProfileId)).resolves.toBeUndefined();
    });
  });

  describe("listContactsForCustomer", () => {
    it("returns zero/one/multiple contacts correctly, primary sorted first", async () => {
      const isolatedProfile = await createTestCustomerProfile();
      try {
        expect(await listContactsForCustomer(isolatedProfile.id)).toEqual([]);

        const { contact: nonPrimary } = await createContact({ customerProfileId: isolatedProfile.id, displayName: "B Niet-primair" }, agent);
        const oneList = await listContactsForCustomer(isolatedProfile.id);
        expect(oneList.map((c) => c.id)).toEqual([nonPrimary.id]);

        const { contact: primary } = await createContact({ customerProfileId: isolatedProfile.id, displayName: "A Primair", isPrimary: true }, agent);
        const multiList = await listContactsForCustomer(isolatedProfile.id);
        expect(multiList[0]!.id).toBe(primary.id);
        expect(multiList).toHaveLength(2);
      } finally {
        await hardCleanupContacts(isolatedProfile.id);
        await cleanupCustomerProfile(isolatedProfile.id);
      }
    });

    it("excludes archived contacts by default, includes them with includeArchived", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Lijst-archief-test" }, agent);
      await archiveContact(customerProfileId, contact.id, agent);

      const active = await listContactsForCustomer(customerProfileId);
      expect(active.some((c) => c.id === contact.id)).toBe(false);

      const all = await listContactsForCustomer(customerProfileId, { includeArchived: true });
      expect(all.some((c) => c.id === contact.id)).toBe(true);
    });
  });

  describe("searchCustomerContacts", () => {
    it("finds a contact by name, email, or phone, with the customer as subtitle context", async () => {
      const profile = await createTestCustomerProfile();
      try {
        await createContact(
          { customerProfileId: profile.id, displayName: "Zoekbaar Contactpersoon", email: "zoekbaar@example.com", phone: "0698765432" },
          agent,
        );

        const byName = await searchCustomerContacts("Zoekbaar Contactpersoon");
        expect(byName.some((c) => c.displayName === "Zoekbaar Contactpersoon")).toBe(true);
        expect(byName[0]!.customerProfile.id).toBe(profile.id);

        const byEmail = await searchCustomerContacts("zoekbaar@example.com");
        expect(byEmail.some((c) => c.displayName === "Zoekbaar Contactpersoon")).toBe(true);
      } finally {
        await hardCleanupContacts(profile.id);
        await cleanupCustomerProfile(profile.id);
      }
    });

    it("never returns an archived contact", async () => {
      const profile = await createTestCustomerProfile();
      try {
        const { contact } = await createContact({ customerProfileId: profile.id, displayName: "Verdwijnt Na Archivering" }, agent);
        await archiveContact(profile.id, contact.id, agent);
        const results = await searchCustomerContacts("Verdwijnt Na Archivering");
        expect(results.some((c) => c.id === contact.id)).toBe(false);
      } finally {
        await hardCleanupContacts(profile.id);
        await cleanupCustomerProfile(profile.id);
      }
    });
  });
});

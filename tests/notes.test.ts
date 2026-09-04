import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { createNote, deleteNote, listNotesForCustomer, pinNote, unpinNote, updateNote } from "@/modules/crm/note.service";
import { createContact, CustomerContactValidationError } from "@/modules/crm/customer-contact.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

describe("note.service", () => {
  let userId: string;
  let otherUserId: string;
  let adminId: string;
  let customerProfileId: string;

  beforeAll(async () => {
    const user = await createTestUser({ role: "AGENT" });
    const other = await createTestUser({ role: "AGENT" });
    const admin = await createTestUser({ role: "ADMIN" });
    const profile = await createTestCustomerProfile();
    userId = user.id;
    otherUserId = other.id;
    adminId = admin.id;
    customerProfileId = profile.id;
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    await cleanupUser(userId);
    await cleanupUser(otherUserId);
    await cleanupUser(adminId);
    await prisma.$disconnect();
  });

  it("creates a note, projects rich text, and writes an Activity + AuditEvent", async () => {
    const note = await createNote({
      customerProfileId,
      authorId: userId,
      bodyPlainText: "Klant gebeld over **levertijd**.",
    });

    expect(note.bodyText).toBe("Klant gebeld over levertijd.");

    const activity = await prisma.activity.findFirst({ where: { relatedNoteId: note.id, type: "NOTE_CREATED" } });
    expect(activity).not.toBeNull();

    const audit = await prisma.auditEvent.findFirst({ where: { entityId: note.id, action: "note.created" } });
    expect(audit).not.toBeNull();
  });

  it("lets the author edit their own note and records editedAt + a NOTE_UPDATED activity", async () => {
    const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Origineel." });
    const updated = await updateNote(note.id, { bodyPlainText: "Bijgewerkt." }, { id: userId, role: "AGENT" });

    expect(updated.bodyText).toBe("Bijgewerkt.");
    expect(updated.editedAt).not.toBeNull();

    const activity = await prisma.activity.findFirst({ where: { relatedNoteId: note.id, type: "NOTE_UPDATED" } });
    expect(activity).not.toBeNull();
  });

  it("soft-deletes a note when the author does it — it disappears from listing but the row remains for audit", async () => {
    const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Te verwijderen." });
    await deleteNote(note.id, { id: userId, role: "AGENT" });

    const listed = await listNotesForCustomer(customerProfileId);
    expect(listed.find((n) => n.id === note.id)).toBeUndefined();

    const raw = await prisma.note.findUnique({ where: { id: note.id } });
    expect(raw?.deletedAt).not.toBeNull();
  });

  // Regression coverage for a real bug found during the Phase 1 production
  // readiness review: updateNote/deleteNote previously applied no ownership
  // check at all, contradicting the documented Phase 1 permission model
  // (docs/platform-discovery/25 §6: AGENT may only edit/delete their own
  // notes) — see docs/build/PHASE-1-PRODUCTION-READINESS.md.
  it("forbids a different AGENT (not the author, not admin) from editing someone else's note", async () => {
    const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Andermans notitie." });
    await expect(
      updateNote(note.id, { bodyPlainText: "Geknoei." }, { id: otherUserId, role: "AGENT" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("forbids a different AGENT from deleting someone else's note", async () => {
    const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Ook andermans." });
    await expect(deleteNote(note.id, { id: otherUserId, role: "AGENT" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets an ADMIN edit and delete any note regardless of authorship", async () => {
    const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Admin mag dit wijzigen." });
    const updated = await updateNote(note.id, { bodyPlainText: "Door admin bewerkt." }, { id: adminId, role: "ADMIN" });
    expect(updated.bodyText).toBe("Door admin bewerkt.");

    await expect(deleteNote(note.id, { id: adminId, role: "ADMIN" })).resolves.not.toThrow();
  });

  describe("Phase 4c — customerContactId invariant (build spec §21)", () => {
    it("allows a contact belonging to the same customer, on create and update", async () => {
      const { contact } = await createContact({ customerProfileId, displayName: "Contactpersoon" }, { id: userId, role: "AGENT" });
      const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Notitie bij Jan.", customerContactId: contact.id });
      expect(note.customerContactId).toBe(contact.id);

      const other = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Nog een notitie." });
      const updated = await updateNote(other.id, { bodyPlainText: "Nu wel gekoppeld.", customerContactId: contact.id }, { id: userId, role: "AGENT" });
      expect(updated.customerContactId).toBe(contact.id);
    });

    it("blocks a contact belonging to a different customer, on create and update", async () => {
      const otherProfile = await createTestCustomerProfile();
      try {
        const { contact } = await createContact({ customerProfileId: otherProfile.id, displayName: "Klant B Contact" }, { id: userId, role: "AGENT" });

        await expect(
          createNote({ customerProfileId, authorId: userId, bodyPlainText: "Verkeerde klant.", customerContactId: contact.id }),
        ).rejects.toBeInstanceOf(CustomerContactValidationError);

        const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Wordt fout gekoppeld." });
        await expect(
          updateNote(note.id, { bodyPlainText: "Poging.", customerContactId: contact.id }, { id: userId, role: "AGENT" }),
        ).rejects.toBeInstanceOf(CustomerContactValidationError);
      } finally {
        await prisma.customerContact.deleteMany({ where: { customerProfileId: otherProfile.id } });
        await cleanupCustomerProfile(otherProfile.id);
      }
    });
  });

  describe("Phase 6d — pinning", () => {
    it("lets the author pin their own note", async () => {
      const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Belangrijk." });
      const pinned = await pinNote(note.id, { id: userId, role: "AGENT" });

      expect(pinned.isPinned).toBe(true);
      expect(pinned.pinnedAt).not.toBeNull();
      expect(pinned.pinnedById).toBe(userId);

      const audit = await prisma.auditEvent.findFirst({ where: { entityId: note.id, action: "note.pinned" } });
      expect(audit).not.toBeNull();
    });

    it("lets a different AGENT (not the author) pin a note — bewuste architectuurkeuze, geen auteur-restrictie", async () => {
      const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Door B te pinnen." });
      const pinned = await pinNote(note.id, { id: otherUserId, role: "AGENT" });

      expect(pinned.isPinned).toBe(true);
      expect(pinned.pinnedById).toBe(otherUserId);
      // Authorship itself is never touched by pinning.
      expect(pinned.authorId).toBe(userId);
    });

    it("pinning an already-pinned note is an idempotent no-op — no rewritten metadata, no second audit", async () => {
      const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Al vastgezet." });
      const first = await pinNote(note.id, { id: userId, role: "AGENT" });
      const second = await pinNote(note.id, { id: otherUserId, role: "AGENT" });

      expect(second.pinnedAt?.getTime()).toBe(first.pinnedAt?.getTime());
      expect(second.pinnedById).toBe(first.pinnedById);

      const auditCount = await prisma.auditEvent.count({ where: { entityId: note.id, action: "note.pinned" } });
      expect(auditCount).toBe(1);
    });

    it("unpins a pinned note and resets pin metadata", async () => {
      const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Los te maken." });
      await pinNote(note.id, { id: userId, role: "AGENT" });
      const unpinned = await unpinNote(note.id, { id: userId, role: "AGENT" });

      expect(unpinned.isPinned).toBe(false);
      expect(unpinned.pinnedAt).toBeNull();
      expect(unpinned.pinnedById).toBeNull();

      const audit = await prisma.auditEvent.findFirst({ where: { entityId: note.id, action: "note.unpinned" } });
      expect(audit).not.toBeNull();
    });

    it("unpinning an already-unpinned note is an idempotent no-op — no audit", async () => {
      const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Nooit vastgezet." });
      const result = await unpinNote(note.id, { id: userId, role: "AGENT" });

      expect(result.isPinned).toBe(false);
      const auditCount = await prisma.auditEvent.count({ where: { entityId: note.id, action: "note.unpinned" } });
      expect(auditCount).toBe(0);
    });

    it("pinning/unpinning never writes an Activity entry — metadata, not a client interaction", async () => {
      const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Geen tijdlijn-ruis." });
      const activitiesBefore = await prisma.activity.count({ where: { relatedNoteId: note.id } });

      await pinNote(note.id, { id: userId, role: "AGENT" });
      await unpinNote(note.id, { id: userId, role: "AGENT" });

      const activitiesAfter = await prisma.activity.count({ where: { relatedNoteId: note.id } });
      expect(activitiesAfter).toBe(activitiesBefore);
    });

    it("sorts pinned notes first, newest-pinned first within that group, unpinned notes keep createdAt-desc order below", async () => {
      const noteA = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Oud, niet vastgezet." });
      const noteB = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Oud, wordt eerst vastgezet." });
      const noteC = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Nieuw, wordt daarna vastgezet." });
      const noteD = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Nieuw, niet vastgezet." });

      await pinNote(noteB.id, { id: userId, role: "AGENT" });
      await pinNote(noteC.id, { id: userId, role: "AGENT" });

      const listed = await listNotesForCustomer(customerProfileId);
      const ids = listed.map((n) => n.id);
      const posB = ids.indexOf(noteB.id);
      const posC = ids.indexOf(noteC.id);
      const posA = ids.indexOf(noteA.id);
      const posD = ids.indexOf(noteD.id);

      // Both pinned notes come before both unpinned notes.
      expect(Math.max(posB, posC)).toBeLessThan(Math.min(posA, posD));
      // Within the pinned group, the more-recently-pinned one (C) comes first.
      expect(posC).toBeLessThan(posB);
      // Within the unpinned group, existing createdAt-desc order is preserved (D newer than A).
      expect(posD).toBeLessThan(posA);
    });

    it("carries pinnedBy as a compact { id, name } relation, not the full user record", async () => {
      const note = await createNote({ customerProfileId, authorId: userId, bodyPlainText: "Met pinnedBy." });
      await pinNote(note.id, { id: otherUserId, role: "AGENT" });

      const listed = await listNotesForCustomer(customerProfileId);
      const found = listed.find((n) => n.id === note.id);
      expect(found?.pinnedBy).toEqual({ id: otherUserId, name: "Test Gebruiker" });
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { deleteFile, updateFileMetadata, listFilesForCustomer } from "@/modules/files/file.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

// Authorization is checked BEFORE any R2 call in file.service.ts (uploader/
// admin only for delete/metadata) — so the forbidden path is fully testable
// without live Cloudflare credentials; only the actual object upload/
// delete requires them (see tests/r2-adapter.test.ts for what IS testable
// there, and docs/build/PHASE-2-IMPLEMENTATION-REPORT.md for what's
// deferred to a live environment).

describe("file.service — authorization", () => {
  let uploader: { id: string; role: "AGENT" };
  let bystander: { id: string; role: "AGENT" };
  let admin: { id: string; role: "ADMIN" };
  let customerProfileId: string;
  let fileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const uploaderUser = await createTestUser({ role: "AGENT" });
    const bystanderUser = await createTestUser({ role: "AGENT" });
    const adminUser = await createTestUser({ role: "ADMIN" });
    const profile = await createTestCustomerProfile();

    uploader = { id: uploaderUser.id, role: "AGENT" };
    bystander = { id: bystanderUser.id, role: "AGENT" };
    admin = { id: adminUser.id, role: "ADMIN" };
    customerProfileId = profile.id;
    userIds.push(uploaderUser.id, bystanderUser.id, adminUser.id);

    // Row created directly (bypassing uploadFile/R2) to isolate the
    // authorization logic under test from the storage adapter.
    const file = await prisma.file.create({
      data: {
        storageKey: `files/${crypto.randomUUID()}.pdf`,
        originalFilename: "test.pdf",
        mimeType: "application/pdf",
        byteSize: 1234,
        customerProfileId,
        uploadedById: uploader.id,
      },
    });
    fileId = file.id;
  });

  afterAll(async () => {
    await prisma.file.deleteMany({ where: { id: fileId } });
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("lets the uploader update metadata", async () => {
    const updated = await updateFileMetadata(fileId, { title: "Bijgewerkte titel" }, uploader);
    expect(updated.title).toBe("Bijgewerkte titel");
  });

  it("forbids an unrelated agent from updating metadata", async () => {
    await expect(updateFileMetadata(fileId, { title: "Ongewenst" }, bystander)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("forbids an unrelated agent from deleting the file (fails before any R2 call)", async () => {
    await expect(deleteFile(fileId, bystander)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets an admin update metadata on a file they didn't upload", async () => {
    const updated = await updateFileMetadata(fileId, { title: "Door beheerder aangepast" }, admin);
    expect(updated.title).toBe("Door beheerder aangepast");
  });

  it("excludes soft-deleted files from the customer's file list", async () => {
    // Simulate a completed soft-delete directly (deleteFile() itself needs
    // live R2 to run past the authorization check tested above).
    await prisma.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    const files = await listFilesForCustomer(customerProfileId);
    expect(files.some((f) => f.id === fileId)).toBe(false);
    await prisma.file.update({ where: { id: fileId }, data: { deletedAt: null } }); // restore for afterAll cleanup symmetry
  });
});

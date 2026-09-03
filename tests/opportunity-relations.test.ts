import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import {
  createOpportunity,
  addExternalLink,
  removeExternalLink,
  searchOpportunities,
  OpportunityValidationError,
} from "@/modules/opportunities/opportunity.service";
import { createTask } from "@/modules/tasks/task.service";
import { createNote } from "@/modules/crm/note.service";
import { createAppointment } from "@/modules/appointments/appointment.service";
import { listFilesForOpportunity } from "@/modules/files/file.service";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

describe("opportunity relations — customerProfileId is always derived, never trusted", () => {
  let owner: { id: string; role: "AGENT" };
  let customerAProfileId: string;
  let customerBProfileId: string;
  let opportunityId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const ownerUser = await createTestUser({ role: "AGENT" });
    owner = { id: ownerUser.id, role: "AGENT" };
    userIds.push(ownerUser.id);

    const profileA = await createTestCustomerProfile();
    const profileB = await createTestCustomerProfile();
    customerAProfileId = profileA.id;
    customerBProfileId = profileB.id;

    const opportunity = await createOpportunity(
      { customerProfileId: customerAProfileId, title: "Klant A opportunity", ownerUserId: owner.id },
      owner,
    );
    opportunityId = opportunity.id;
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerAProfileId);
    await cleanupCustomerProfile(customerBProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("createTask: opportunityId of customer A forces customerProfileId to A, even if caller passes B", async () => {
    const task = await createTask(
      { title: "Taak", assignedToId: owner.id, customerProfileId: customerBProfileId, opportunityId },
      owner,
    );
    expect(task.customerProfileId).toBe(customerAProfileId);
    expect(task.customerProfileId).not.toBe(customerBProfileId);
    expect(task.opportunityId).toBe(opportunityId);

    const activity = await prisma.activity.findFirst({ where: { relatedTaskId: task.id, relatedOpportunityId: opportunityId } });
    expect(activity).not.toBeNull();
  });

  it("createNote: same invariant holds", async () => {
    const note = await createNote({
      authorId: owner.id,
      bodyPlainText: "Notitie bij opportunity",
      customerProfileId: customerBProfileId,
      opportunityId,
    });
    expect(note.customerProfileId).toBe(customerAProfileId);
    expect(note.opportunityId).toBe(opportunityId);
  });

  it("createAppointment: same invariant holds", async () => {
    const appointment = await createAppointment(
      {
        title: "Showroom-bezoek",
        startsAt: new Date(Date.now() + 86_400_000),
        assignedToId: owner.id,
        customerProfileId: customerBProfileId,
        opportunityId,
      },
      owner,
    );
    expect(appointment.customerProfileId).toBe(customerAProfileId);
    expect(appointment.opportunityId).toBe(opportunityId);
  });

  it("File: a directly-created opportunity-scoped file is correctly filtered by listFilesForOpportunity", async () => {
    // Mirrors tests/files.test.ts's own pattern — the R2 upload path itself
    // needs live storage credentials, so the row is created directly here
    // to isolate the query/filter behavior under test.
    const file = await prisma.file.create({
      data: {
        storageKey: `files/${crypto.randomUUID()}.pdf`,
        originalFilename: "offerte.pdf",
        mimeType: "application/pdf",
        byteSize: 100,
        customerProfileId: customerAProfileId,
        opportunityId,
        uploadedById: owner.id,
      },
    });

    const files = await listFilesForOpportunity(opportunityId);
    expect(files.some((f) => f.id === file.id)).toBe(true);

    await prisma.file.delete({ where: { id: file.id } });
  });

  it("opportunity-scoped search finds by title and by customer name", async () => {
    const titleResults = await searchOpportunities("Klant A opportunity");
    expect(titleResults.some((o) => o.id === opportunityId)).toBe(true);

    const customer = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customerAProfileId } });
    const nameResults = await searchOpportunities(customer.displayName ?? "");
    expect(nameResults.some((o) => o.id === opportunityId)).toBe(true);
  });
});

describe("opportunity external links", () => {
  let owner: { id: string; role: "AGENT" };
  let customerProfileId: string;
  let opportunityAId: string;
  let opportunityBId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const ownerUser = await createTestUser({ role: "AGENT" });
    owner = { id: ownerUser.id, role: "AGENT" };
    userIds.push(ownerUser.id);

    const profile = await createTestCustomerProfile();
    customerProfileId = profile.id;

    const a = await createOpportunity({ customerProfileId, title: "Opportunity A", ownerUserId: owner.id }, owner);
    const b = await createOpportunity({ customerProfileId, title: "Opportunity B", ownerUserId: owner.id }, owner);
    opportunityAId = a.id;
    opportunityBId = b.id;
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("adds a quote link", async () => {
    const link = await addExternalLink(opportunityAId, { linkType: "OFFERTEAPP_QUOTE", externalRef: "Q-1234" }, owner);
    expect(link.linkType).toBe("OFFERTEAPP_QUOTE");
    expect(link.externalRef).toBe("Q-1234");
    expect(link.unlinkedAt).toBeNull();

    const audit = await prisma.auditEvent.findFirst({ where: { entityId: link.id, action: "opportunity.external_link_added" } });
    expect(audit).not.toBeNull();
  });

  it("adds two different link types independently", async () => {
    // Shopify-backed link types (SHOPIFY_ORDER/SHOPIFY_DRAFT_ORDER) now
    // require a live Shopify customer-identity check (pre-production
    // review finding E/6) — covered with proper mocking in
    // tests/opportunity-shopify-links.test.ts. This test keeps its
    // original "two link types work independently" intent using the two
    // quote types, which don't need Shopify mocking.
    const offerteLink = await addExternalLink(opportunityAId, { linkType: "OFFERTEAPP_QUOTE", externalRef: "Q-INDEP-1" }, owner);
    const s4uLink = await addExternalLink(opportunityAId, { linkType: "S4U_QUOTE_APP_QUOTE", externalRef: "S4U-INDEP-1" }, owner);
    expect(offerteLink.linkType).toBe("OFFERTEAPP_QUOTE");
    expect(s4uLink.linkType).toBe("S4U_QUOTE_APP_QUOTE");
  });

  it("dedupes on (opportunity, linkType, externalRef) via upsert — no duplicate rows", async () => {
    const first = await addExternalLink(opportunityAId, { linkType: "S4U_QUOTE_APP_QUOTE", externalRef: "S4U-1" }, owner);
    const second = await addExternalLink(opportunityAId, { linkType: "S4U_QUOTE_APP_QUOTE", externalRef: "S4U-1" }, owner);
    expect(second.id).toBe(first.id);

    const count = await prisma.opportunityExternalLink.count({
      where: { opportunityId: opportunityAId, linkType: "S4U_QUOTE_APP_QUOTE", externalRef: "S4U-1" },
    });
    expect(count).toBe(1);
  });

  it("the same external ref can be linked to two different opportunities independently", async () => {
    await addExternalLink(opportunityAId, { linkType: "OFFERTEAPP_QUOTE", externalRef: "Q-SHARED" }, owner);
    await addExternalLink(opportunityBId, { linkType: "OFFERTEAPP_QUOTE", externalRef: "Q-SHARED" }, owner);

    const countA = await prisma.opportunityExternalLink.count({ where: { opportunityId: opportunityAId, externalRef: "Q-SHARED" } });
    const countB = await prisma.opportunityExternalLink.count({ where: { opportunityId: opportunityBId, externalRef: "Q-SHARED" } });
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  it("removes (soft-unlinks) a link", async () => {
    const link = await addExternalLink(opportunityAId, { linkType: "OFFERTEAPP_QUOTE", externalRef: "Q-REMOVE" }, owner);
    const removed = await removeExternalLink(opportunityAId, link.id, owner);
    expect(removed.unlinkedAt).not.toBeNull();

    const detail = await prisma.opportunity.findUniqueOrThrow({
      where: { id: opportunityAId },
      include: { externalLinks: { where: { unlinkedAt: null } } },
    });
    expect(detail.externalLinks.some((l) => l.id === link.id)).toBe(false);

    const audit = await prisma.auditEvent.findFirst({ where: { entityId: link.id, action: "opportunity.external_link_removed" } });
    expect(audit).not.toBeNull();
  });

  it("IDOR: refuses to remove a link that belongs to a different opportunity", async () => {
    const link = await addExternalLink(opportunityAId, { linkType: "OFFERTEAPP_QUOTE", externalRef: "Q-IDOR" }, owner);
    await expect(removeExternalLink(opportunityBId, link.id, owner)).rejects.toBeInstanceOf(OpportunityValidationError);

    // The link must remain untouched by the failed cross-opportunity attempt.
    const stillLinked = await prisma.opportunityExternalLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(stillLinked.unlinkedAt).toBeNull();
  });

  it("rejects an empty externalRef", async () => {
    await expect(addExternalLink(opportunityAId, { linkType: "OFFERTEAPP_QUOTE", externalRef: "  " }, owner)).rejects.toBeInstanceOf(
      OpportunityValidationError,
    );
  });
});

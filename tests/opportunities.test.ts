import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import {
  createOpportunity,
  updateOpportunity,
  changeStage,
  assignOwner,
  markWon,
  markLost,
  reopen,
  archiveOpportunity,
  listOpportunities,
  listOpportunitiesForCustomer,
  getOpportunityDetail,
  OpportunityValidationError,
} from "@/modules/opportunities/opportunity.service";
import { ForbiddenError } from "@/platform/auth/guards";
import { createTestCustomerProfile, createTestUser, cleanupCustomerProfile, cleanupUser } from "./fixtures";

describe("opportunity.service — core", () => {
  let owner: { id: string; role: "AGENT" };
  let creator: { id: string; role: "AGENT" };
  let bystander: { id: string; role: "AGENT" };
  let admin: { id: string; role: "ADMIN" };
  let viewer: { id: string; role: "VIEWER" };
  let customerProfileId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const ownerUser = await createTestUser({ role: "AGENT" });
    const creatorUser = await createTestUser({ role: "AGENT" });
    const bystanderUser = await createTestUser({ role: "AGENT" });
    const adminUser = await createTestUser({ role: "ADMIN" });
    const viewerUser = await createTestUser({ role: "VIEWER" });
    const profile = await createTestCustomerProfile();

    owner = { id: ownerUser.id, role: "AGENT" };
    creator = { id: creatorUser.id, role: "AGENT" };
    bystander = { id: bystanderUser.id, role: "AGENT" };
    admin = { id: adminUser.id, role: "ADMIN" };
    viewer = { id: viewerUser.id, role: "VIEWER" };
    customerProfileId = profile.id;
    userIds.push(ownerUser.id, creatorUser.id, bystanderUser.id, adminUser.id, viewerUser.id);
  });

  afterAll(async () => {
    await cleanupCustomerProfile(customerProfileId);
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  it("creates an opportunity with default fields", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Terras + zwembadproject" }, creator);
    expect(opportunity.stage).toBe("NEW");
    expect(opportunity.status).toBe("OPEN");
    expect(opportunity.archivedAt).toBeNull();
    expect(opportunity.wonAt).toBeNull();
    expect(opportunity.lostAt).toBeNull();

    const activity = await prisma.activity.findFirst({ where: { relatedOpportunityId: opportunity.id, type: "OPPORTUNITY_CREATED" } });
    expect(activity).not.toBeNull();

    const audit = await prisma.auditEvent.findFirst({ where: { entityId: opportunity.id, action: "opportunity.created" } });
    expect(audit).not.toBeNull();
  });

  it("defaults the owner to the customer's accountmanager when set", async () => {
    await prisma.customerProfile.update({ where: { id: customerProfileId }, data: { accountManagerId: owner.id } });
    const opportunity = await createOpportunity({ customerProfileId, title: "Met accountmanager" }, creator);
    expect(opportunity.ownerUserId).toBe(owner.id);
    await prisma.customerProfile.update({ where: { id: customerProfileId }, data: { accountManagerId: null } });
  });

  it("falls back to the creator as owner when the customer has no accountmanager", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Zonder accountmanager" }, creator);
    expect(opportunity.ownerUserId).toBe(creator.id);
  });

  it("falls back to the creator as owner when the customer's accountmanager is inactive (never silently assigns an inactive owner)", async () => {
    const inactiveManager = await createTestUser({ role: "AGENT" });
    await prisma.user.update({ where: { id: inactiveManager.id }, data: { active: false } });
    userIds.push(inactiveManager.id);

    await prisma.customerProfile.update({ where: { id: customerProfileId }, data: { accountManagerId: inactiveManager.id } });
    const opportunity = await createOpportunity({ customerProfileId, title: "Inactieve accountmanager" }, creator);
    expect(opportunity.ownerUserId).toBe(creator.id);
    expect(opportunity.ownerUserId).not.toBe(inactiveManager.id);

    await prisma.customerProfile.update({ where: { id: customerProfileId }, data: { accountManagerId: null } });
  });

  it("rejects an explicitly-provided inactive owner", async () => {
    const inactiveUser = await createTestUser({ role: "AGENT" });
    await prisma.user.update({ where: { id: inactiveUser.id }, data: { active: false } });
    userIds.push(inactiveUser.id);

    await expect(
      createOpportunity({ customerProfileId, title: "Expliciet inactieve eigenaar", ownerUserId: inactiveUser.id }, creator),
    ).rejects.toBeInstanceOf(OpportunityValidationError);
  });

  it("rejects an empty title", async () => {
    await expect(createOpportunity({ customerProfileId, title: "   " }, creator)).rejects.toBeInstanceOf(OpportunityValidationError);
  });

  it("rejects a negative estimated value", async () => {
    await expect(createOpportunity({ customerProfileId, title: "Negatieve waarde", estimatedValue: -100 }, creator)).rejects.toBeInstanceOf(
      OpportunityValidationError,
    );
  });

  it("rejects an out-of-range probability", async () => {
    await expect(createOpportunity({ customerProfileId, title: "Ongeldige kans", probability: 150 }, creator)).rejects.toBeInstanceOf(
      OpportunityValidationError,
    );
  });

  it("stores estimatedValue as a Decimal and returns it precisely on read", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Decimal-test", estimatedValue: "18500.5" }, creator);
    const fetched = await getOpportunityDetail(opportunity.id);
    expect(Number(fetched.estimatedValue)).toBe(18500.5);
  });

  describe("money validation (estimatedValue + finalValue) — pre-production review finding B/4", () => {
    const ACCEPTED: [string, number][] = [
      ["0", 0],
      ["0.01", 0.01],
      ["10.10", 10.1],
      ["18500", 18500],
      ["18500.00", 18500],
      ["9999999999.99", 9999999999.99],
    ];
    const REJECTED = ["-0.01", "10000000000.00", "1e10", "1E3", "10.123", "NaN", "abc", "  ", "18500,00"];

    it.each(ACCEPTED)("accepts estimatedValue = %s (create)", async (input) => {
      const opportunity = await createOpportunity({ customerProfileId, title: `Geldig bedrag ${input}`, estimatedValue: input }, creator);
      expect(Number(opportunity.estimatedValue)).toBeCloseTo(Number(input), 2);
    });

    it.each(REJECTED)("rejects estimatedValue = %s (create)", async (input) => {
      await expect(
        createOpportunity({ customerProfileId, title: `Ongeldig bedrag ${input}`, estimatedValue: input }, creator),
      ).rejects.toBeInstanceOf(OpportunityValidationError);
    });

    it("rejects Infinity and -Infinity as a raw number", async () => {
      await expect(
        createOpportunity({ customerProfileId, title: "Infinity-test", estimatedValue: Infinity }, creator),
      ).rejects.toBeInstanceOf(OpportunityValidationError);
      await expect(
        createOpportunity({ customerProfileId, title: "Neg-infinity-test", estimatedValue: -Infinity }, creator),
      ).rejects.toBeInstanceOf(OpportunityValidationError);
    });

    it("rejects NaN as a raw number", async () => {
      await expect(createOpportunity({ customerProfileId, title: "NaN-number-test", estimatedValue: NaN }, creator)).rejects.toBeInstanceOf(
        OpportunityValidationError,
      );
    });

    it("accepts a plain JS number input, normalized defensively to a clean 2-decimal value", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Number-input-test", estimatedValue: 18500.5 }, creator);
      expect(Number(opportunity.estimatedValue)).toBe(18500.5);
    });

    it("rejects a JS number with a genuine third decimal (not just float noise)", async () => {
      await expect(
        createOpportunity({ customerProfileId, title: "Number-3-decimal-test", estimatedValue: 10.129 }, creator),
      ).rejects.toBeInstanceOf(OpportunityValidationError);
    });

    it("accepts harmless binary-float noise from number arithmetic (0.1 + 0.2)", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Float-noise-test", estimatedValue: 0.1 + 0.2 }, creator);
      expect(Number(opportunity.estimatedValue)).toBe(0.3);
    });

    it("rejects an out-of-range overflow with a clean OpportunityValidationError, never an unhandled database error", async () => {
      await expect(
        createOpportunity({ customerProfileId, title: "Overflow-test", estimatedValue: "10000000000.00" }, creator),
      ).rejects.toBeInstanceOf(OpportunityValidationError);
    });

    it("applies the same validation to finalValue on markWon", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "FinalValue-validatie", ownerUserId: owner.id }, creator);
      await expect(markWon(opportunity.id, { finalValue: "1e10" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
      await expect(markWon(opportunity.id, { finalValue: "10.123" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
      await expect(markWon(opportunity.id, { finalValue: "-5" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
      await expect(markWon(opportunity.id, { finalValue: "10000000000.00" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);

      const won = await markWon(opportunity.id, { finalValue: "9999999999.99" }, owner);
      expect(Number(won.finalValue)).toBe(9999999999.99);
    });

    it("applies the same validation to estimatedValue on updateOpportunity (while OPEN)", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Update-validatie", ownerUserId: owner.id }, creator);
      await expect(updateOpportunity(opportunity.id, { estimatedValue: "10.123" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
      const updated = await updateOpportunity(opportunity.id, { estimatedValue: "250.50" }, owner);
      expect(Number(updated.estimatedValue)).toBe(250.5);
    });
  });

  it("stores and returns expectedCloseDate", async () => {
    const closeDate = new Date("2026-10-15T00:00:00.000Z");
    const opportunity = await createOpportunity({ customerProfileId, title: "Met sluitdatum", expectedCloseDate: closeDate }, creator);
    expect(opportunity.expectedCloseDate?.toISOString()).toBe(closeDate.toISOString());
  });

  it("updates title/description/probability and logs distinct audit actions for value vs. other fields", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Origineel", ownerUserId: owner.id }, creator);

    await updateOpportunity(opportunity.id, { title: "Bijgewerkt", probability: 55 }, owner);
    const afterFieldUpdate = await prisma.auditEvent.findFirst({ where: { entityId: opportunity.id, action: "opportunity.updated" } });
    expect(afterFieldUpdate).not.toBeNull();

    await updateOpportunity(opportunity.id, { estimatedValue: "5000" }, owner);
    const afterValueUpdate = await prisma.auditEvent.findFirst({ where: { entityId: opportunity.id, action: "opportunity.value_changed" } });
    expect(afterValueUpdate).not.toBeNull();

    const fetched = await getOpportunityDetail(opportunity.id);
    expect(fetched.title).toBe("Bijgewerkt");
    expect(fetched.probability).toBe(55);
    expect(Number(fetched.estimatedValue)).toBe(5000);
  });

  it("changes stage while open and records OPPORTUNITY_STAGE_CHANGED", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Fase-test", ownerUserId: owner.id }, creator);
    const updated = await changeStage(opportunity.id, "QUOTE_SENT", owner);
    expect(updated.stage).toBe("QUOTE_SENT");

    const activity = await prisma.activity.findFirst({ where: { relatedOpportunityId: opportunity.id, type: "OPPORTUNITY_STAGE_CHANGED" } });
    expect(activity).not.toBeNull();
  });

  it("refuses a stage change on a closed opportunity", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Gesloten fase-test", ownerUserId: owner.id }, creator);
    await markLost(opportunity.id, { lostReason: "Te duur" }, owner);
    await expect(changeStage(opportunity.id, "NEGOTIATION", owner)).rejects.toBeInstanceOf(OpportunityValidationError);
  });

  it("marks an opportunity won, defaulting finalValue to estimatedValue", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Win-test", estimatedValue: "1000", ownerUserId: owner.id }, creator);
    const won = await markWon(opportunity.id, {}, owner);
    expect(won.status).toBe("WON");
    expect(won.wonAt).not.toBeNull();
    expect(Number(won.finalValue)).toBe(1000);

    const activity = await prisma.activity.findFirst({ where: { relatedOpportunityId: opportunity.id, type: "OPPORTUNITY_WON" } });
    expect(activity).not.toBeNull();
    const audit = await prisma.auditEvent.findFirst({ where: { entityId: opportunity.id, action: "opportunity.won" } });
    expect(audit).not.toBeNull();
  });

  it("uses an explicit finalValue over estimatedValue when won", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Expliciete waarde", estimatedValue: "1000", ownerUserId: owner.id }, creator);
    const won = await markWon(opportunity.id, { finalValue: "1250.75" }, owner);
    expect(won.finalValue?.toString()).toBe("1250.75");
  });

  it("marks an opportunity lost, requiring a reason, and freezes the stage", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Verlies-test", ownerUserId: owner.id }, creator);
    await changeStage(opportunity.id, "NEGOTIATION", owner);
    await expect(markLost(opportunity.id, { lostReason: "" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);

    const lost = await markLost(opportunity.id, { lostReason: "Klant koos concurrent" }, owner);
    expect(lost.status).toBe("LOST");
    expect(lost.lostAt).not.toBeNull();
    expect(lost.lostReason).toBe("Klant koos concurrent");
    expect(lost.stage).toBe("NEGOTIATION");
  });

  it("reopens a lost opportunity — clears lostReason AND lostAt, keeps stage, canonical state only", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Heropen-test", ownerUserId: owner.id }, creator);
    await changeStage(opportunity.id, "QUOTE_SENT", owner);
    await markLost(opportunity.id, { lostReason: "Prijs" }, owner);

    const reopened = await reopen(opportunity.id, owner);
    expect(reopened.status).toBe("OPEN");
    expect(reopened.stage).toBe("QUOTE_SENT");
    expect(reopened.lostReason).toBeNull();
    expect(reopened.lostAt).toBeNull();
    expect(reopened.wonAt).toBeNull();
    expect(reopened.finalValue).toBeNull();

    const activity = await prisma.activity.findFirst({ where: { relatedOpportunityId: opportunity.id, type: "OPPORTUNITY_REOPENED" } });
    expect(activity).not.toBeNull();
    // Full history stays available via AuditEvent regardless of the
    // now-cleared Opportunity-row fields.
    const lostAudit = await prisma.auditEvent.findFirst({ where: { entityId: opportunity.id, action: "opportunity.lost" } });
    const reopenedAudit = await prisma.auditEvent.findFirst({ where: { entityId: opportunity.id, action: "opportunity.reopened" } });
    expect(lostAudit).not.toBeNull();
    expect(reopenedAudit).not.toBeNull();
  });

  it("OPEN -> WON -> REOPEN: status OPEN, wonAt/lostAt/lostReason/finalValue all null", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Won-reopen-test", estimatedValue: "1000", ownerUserId: owner.id }, creator);
    await markWon(opportunity.id, {}, owner);

    const reopened = await reopen(opportunity.id, owner);
    expect(reopened.status).toBe("OPEN");
    expect(reopened.wonAt).toBeNull();
    expect(reopened.lostAt).toBeNull();
    expect(reopened.lostReason).toBeNull();
    expect(reopened.finalValue).toBeNull();
  });

  it("OPEN -> WON -> REOPEN -> LOST: status LOST, wonAt null, lostAt filled, finalValue null (no stale WON-era value)", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Won-reopen-lost-test", estimatedValue: "1000", ownerUserId: owner.id }, creator);
    await markWon(opportunity.id, { finalValue: "1234.56" }, owner);
    await reopen(opportunity.id, owner);
    const lost = await markLost(opportunity.id, { lostReason: "Alsnog afgewezen" }, owner);

    expect(lost.status).toBe("LOST");
    expect(lost.wonAt).toBeNull();
    expect(lost.lostAt).not.toBeNull();
    expect(lost.finalValue).toBeNull();
  });

  describe("strict state transitions — pre-production review finding A/2", () => {
    it("OPEN -> WON succeeds", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Transition OPEN->WON", ownerUserId: owner.id }, creator);
      const won = await markWon(opportunity.id, {}, owner);
      expect(won.status).toBe("WON");
    });

    it("OPEN -> LOST succeeds", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Transition OPEN->LOST", ownerUserId: owner.id }, creator);
      const lost = await markLost(opportunity.id, { lostReason: "Reden" }, owner);
      expect(lost.status).toBe("LOST");
    });

    it("WON -> LOST is blocked (must reopen first)", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Transition WON->LOST blocked", ownerUserId: owner.id }, creator);
      await markWon(opportunity.id, {}, owner);
      await expect(markLost(opportunity.id, { lostReason: "Reden" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);

      const stillWon = await getOpportunityDetail(opportunity.id);
      expect(stillWon.status).toBe("WON");
    });

    it("LOST -> WON is blocked (must reopen first)", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Transition LOST->WON blocked", ownerUserId: owner.id }, creator);
      await markLost(opportunity.id, { lostReason: "Reden" }, owner);
      await expect(markWon(opportunity.id, {}, owner)).rejects.toBeInstanceOf(OpportunityValidationError);

      const stillLost = await getOpportunityDetail(opportunity.id);
      expect(stillLost.status).toBe("LOST");
    });

    it("WON -> reopen -> LOST succeeds", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Transition WON->reopen->LOST", ownerUserId: owner.id }, creator);
      await markWon(opportunity.id, {}, owner);
      await reopen(opportunity.id, owner);
      const lost = await markLost(opportunity.id, { lostReason: "Alsnog verloren" }, owner);
      expect(lost.status).toBe("LOST");
    });

    it("LOST -> reopen -> WON succeeds", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Transition LOST->reopen->WON", ownerUserId: owner.id }, creator);
      await markLost(opportunity.id, { lostReason: "Eerst verloren" }, owner);
      await reopen(opportunity.id, owner);
      const won = await markWon(opportunity.id, {}, owner);
      expect(won.status).toBe("WON");
    });

    it("repeated markWon on an already-WON opportunity stays idempotent — no duplicate audit/Activity", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Repeated markWon", ownerUserId: owner.id }, creator);
      await markWon(opportunity.id, {}, owner);
      await markWon(opportunity.id, {}, owner);
      await markWon(opportunity.id, {}, owner);

      const activityCount = await prisma.activity.count({ where: { relatedOpportunityId: opportunity.id, type: "OPPORTUNITY_WON" } });
      const auditCount = await prisma.auditEvent.count({ where: { entityId: opportunity.id, action: "opportunity.won" } });
      expect(activityCount).toBe(1);
      expect(auditCount).toBe(1);
    });

    it("repeated markLost on an already-LOST opportunity stays idempotent — no duplicate audit/Activity", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Repeated markLost", ownerUserId: owner.id }, creator);
      await markLost(opportunity.id, { lostReason: "Reden A" }, owner);
      await markLost(opportunity.id, { lostReason: "Reden B (mag niet overschrijven)" }, owner);

      const activityCount = await prisma.activity.count({ where: { relatedOpportunityId: opportunity.id, type: "OPPORTUNITY_LOST" } });
      const auditCount = await prisma.auditEvent.count({ where: { entityId: opportunity.id, action: "opportunity.lost" } });
      expect(activityCount).toBe(1);
      expect(auditCount).toBe(1);

      const fetched = await getOpportunityDetail(opportunity.id);
      expect(fetched.lostReason).toBe("Reden A"); // first write wins, idempotent no-op never overwrites
    });
  });

  describe("update blocked on closed opportunities — pre-production review finding A/3", () => {
    it("blocks a content update on a WON opportunity", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Update-block WON", ownerUserId: owner.id }, creator);
      await markWon(opportunity.id, {}, owner);
      await expect(updateOpportunity(opportunity.id, { title: "Mag niet" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
      await expect(updateOpportunity(opportunity.id, { estimatedValue: "500" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
      await expect(updateOpportunity(opportunity.id, { probability: 50 }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
      await expect(updateOpportunity(opportunity.id, { expectedCloseDate: new Date() }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
    });

    it("blocks a content update on a LOST opportunity", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Update-block LOST", ownerUserId: owner.id }, creator);
      await markLost(opportunity.id, { lostReason: "Reden" }, owner);
      await expect(updateOpportunity(opportunity.id, { description: "Mag niet" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
    });

    it("allows the update again once reopened", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Update-block reopen", ownerUserId: owner.id }, creator);
      await markWon(opportunity.id, {}, owner);
      await reopen(opportunity.id, owner);
      const updated = await updateOpportunity(opportunity.id, { title: "Weer bewerkbaar" }, owner);
      expect(updated.title).toBe("Weer bewerkbaar");
    });

    it("still allows owner reassignment on a closed opportunity (deliberate exception, see assignOwner comment)", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "Owner-change-on-closed", ownerUserId: owner.id }, creator);
      await markWon(opportunity.id, {}, owner);
      const updated = await assignOwner(opportunity.id, bystander.id, owner);
      expect(updated.ownerUserId).toBe(bystander.id);
    });
  });

  it("archives an opportunity and refuses further mutation until unarchived scope is out of 4a", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Archiveer-test", ownerUserId: owner.id }, creator);
    const archived = await archiveOpportunity(opportunity.id, owner);
    expect(archived.archivedAt).not.toBeNull();

    await expect(changeStage(opportunity.id, "CONTACTED", owner)).rejects.toBeInstanceOf(OpportunityValidationError);
    await expect(updateOpportunity(opportunity.id, { title: "Mag niet" }, owner)).rejects.toBeInstanceOf(OpportunityValidationError);
  });

  it("changes owner and writes a dedicated audit action", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Eigenaar-test", ownerUserId: owner.id }, creator);
    const updated = await assignOwner(opportunity.id, bystander.id, owner);
    expect(updated.ownerUserId).toBe(bystander.id);

    const audit = await prisma.auditEvent.findFirst({ where: { entityId: opportunity.id, action: "opportunity.owner_changed" } });
    expect(audit).not.toBeNull();
  });

  it("rejects assigning an owner that does not exist", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Ongeldige eigenaar", ownerUserId: owner.id }, creator);
    await expect(assignOwner(opportunity.id, "not-a-real-user-id", owner)).rejects.toBeInstanceOf(OpportunityValidationError);
  });

  it("supports multiple concurrent open opportunities for the same customer", async () => {
    const a = await createOpportunity({ customerProfileId, title: "Traject A", ownerUserId: owner.id }, creator);
    const b = await createOpportunity({ customerProfileId, title: "Traject B", ownerUserId: owner.id }, creator);

    const forCustomer = await listOpportunitiesForCustomer(customerProfileId);
    const ids = forCustomer.map((o) => o.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("lists open opportunities by default and excludes archived ones", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Lijst-filter-test", ownerUserId: owner.id }, creator);
    await archiveOpportunity(opportunity.id, owner);

    const openList = await listOpportunities({ customerProfileId, status: "OPEN" });
    expect(openList.some((o) => o.id === opportunity.id)).toBe(false);

    const archivedList = await listOpportunities({ customerProfileId, archived: "only" });
    expect(archivedList.some((o) => o.id === opportunity.id)).toBe(true);
  });

  it("filters by stage", async () => {
    const opportunity = await createOpportunity({ customerProfileId, title: "Stage-filter-test", ownerUserId: owner.id }, creator);
    await changeStage(opportunity.id, "NEGOTIATION", owner);

    const filtered = await listOpportunities({ customerProfileId, stage: "NEGOTIATION" });
    expect(filtered.some((o) => o.id === opportunity.id)).toBe(true);

    const wrongStage = await listOpportunities({ customerProfileId, stage: "NEW" });
    expect(wrongStage.some((o) => o.id === opportunity.id)).toBe(false);
  });

  it("WON/LOST semantics: won and lost opportunities never appear in the default OPEN list", async () => {
    const won = await createOpportunity({ customerProfileId, title: "Wordt gewonnen", ownerUserId: owner.id }, creator);
    await markWon(won.id, {}, owner);
    const lost = await createOpportunity({ customerProfileId, title: "Wordt verloren", ownerUserId: owner.id }, creator);
    await markLost(lost.id, { lostReason: "Reden" }, owner);

    const openList = await listOpportunities({ customerProfileId, status: "OPEN" });
    expect(openList.some((o) => o.id === won.id)).toBe(false);
    expect(openList.some((o) => o.id === lost.id)).toBe(false);

    const allList = await listOpportunities({ customerProfileId, status: "ALL" });
    expect(allList.some((o) => o.id === won.id)).toBe(true);
    expect(allList.some((o) => o.id === lost.id)).toBe(true);
  });

  describe("RBAC", () => {
    it("lets the owner modify the opportunity", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "RBAC eigenaar", ownerUserId: owner.id }, creator);
      const updated = await changeStage(opportunity.id, "CONTACTED", owner);
      expect(updated.stage).toBe("CONTACTED");
    });

    it("lets the creator modify the opportunity even if not owner", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "RBAC aanmaker", ownerUserId: bystander.id }, creator);
      const updated = await changeStage(opportunity.id, "CONTACTED", creator);
      expect(updated.stage).toBe("CONTACTED");
    });

    it("lets an admin modify any opportunity", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "RBAC admin", ownerUserId: owner.id }, creator);
      const updated = await changeStage(opportunity.id, "CONTACTED", admin);
      expect(updated.stage).toBe("CONTACTED");
    });

    it("forbids an unrelated agent (not owner, not creator, not admin) from modifying", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "RBAC omstander", ownerUserId: owner.id }, creator);
      await expect(changeStage(opportunity.id, "CONTACTED", bystander)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("forbids a VIEWER from any mutation", async () => {
      const opportunity = await createOpportunity({ customerProfileId, title: "RBAC viewer", ownerUserId: owner.id }, creator);
      await expect(changeStage(opportunity.id, "CONTACTED", viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markWon(opportunity.id, {}, viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markLost(opportunity.id, { lostReason: "x" }, viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(archiveOpportunity(opportunity.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(assignOwner(opportunity.id, bystander.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

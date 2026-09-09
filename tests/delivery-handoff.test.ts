import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import {
  createDeliveryDateHandoff,
  createOrGetOrderDeliveryHandoff,
  getHandoffByRawToken,
  listAllDeliveryDateHandoffs,
  listDeliveryDateHandoffsForCustomer,
  parseRequestedDeliveryDate,
  regeneratePublicToken,
  resolveCustomerProfileIdForShopifyGid,
  submitRequestedDeliveryDate,
  submitRequestedDeliveryDateForOrder,
} from "@/modules/delivery/delivery-handoff.service";
import { DeliveryHandoffError } from "@/modules/delivery/errors";
import { generatePublicToken, hashPublicToken } from "@/modules/delivery/token";
import {
  createTestCustomerProfile,
  createTestUser,
  cleanupCustomerProfile,
  cleanupDeliveryDateHandoff,
  cleanupUser,
} from "./fixtures";

const mockMirror = vi.fn();
vi.mock("@/integrations/shopify/draft-order-mirror", () => ({
  mirrorRequestedDeliveryDateToShopify: (...args: unknown[]) => mockMirror(...args),
}));

const mockOrderMirror = vi.fn();
vi.mock("@/integrations/shopify/order-mirror", () => ({
  mirrorRequestedDeliveryDateToOrder: (...args: unknown[]) => mockOrderMirror(...args),
}));

const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);

describe("delivery-handoff.service", () => {
  let userId: string;
  let customerProfileId: string;
  const createdHandoffIds: string[] = [];

  beforeAll(async () => {
    const user = await createTestUser({ role: "AGENT" });
    const profile = await createTestCustomerProfile();
    userId = user.id;
    customerProfileId = profile.id;
  });

  beforeEach(() => {
    mockMirror.mockReset();
    mockMirror.mockResolvedValue({ invoiceUrl: "https://test-shop.myshopify.com/12345/invoices/abc" });
    mockOrderMirror.mockReset();
    mockOrderMirror.mockResolvedValue({ orderGid: "gid://shopify/Order/1" });
  });

  afterAll(async () => {
    for (const id of createdHandoffIds) await cleanupDeliveryDateHandoff(id);
    await cleanupCustomerProfile(customerProfileId);
    await cleanupUser(userId);
    await prisma.$disconnect();
  });

  describe("data model — create, uniqueness, token safety", () => {
    it("creates a handoff and stores only a token hash, never the raw token", async () => {
      const draftOrderGid = `gid://shopify/DraftOrder/${crypto.randomUUID()}`;
      const { handoff, rawToken } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: draftOrderGid,
        customerProfileId,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);

      expect(rawToken).toBeTruthy();
      expect(handoff.publicTokenHash).not.toBe(rawToken);
      expect(handoff.publicTokenHash).toBe(hashPublicToken(rawToken!));
      expect(handoff.sourceSystem).toBe("SHOPIFY");
      expect(handoff.externalId).toBe(draftOrderGid);
      expect(handoff.status).toBe("PENDING");

      const audit = await prisma.auditEvent.findFirst({
        where: { entityId: handoff.id, action: "delivery_handoff.created" },
      });
      expect(audit).not.toBeNull();
    });

    it("is idempotent per (sourceSystem, externalId) — a repeat create returns the existing row, no new raw token", async () => {
      const draftOrderGid = `gid://shopify/DraftOrder/${crypto.randomUUID()}`;
      const first = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: draftOrderGid,
        customerProfileId,
        createdById: userId,
      });
      createdHandoffIds.push(first.handoff.id);

      const second = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: draftOrderGid,
        customerProfileId,
        createdById: userId,
      });

      expect(second.handoff.id).toBe(first.handoff.id);
      expect(second.rawToken).toBeNull();

      const count = await prisma.deliveryDateHandoff.count({ where: { externalId: draftOrderGid } });
      expect(count).toBe(1);
    });

    it("resolves a handoff only via its own correct raw token — a different, freshly generated token never matches", async () => {
      const draftOrderGid = `gid://shopify/DraftOrder/${crypto.randomUUID()}`;
      const { handoff, rawToken } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: draftOrderGid,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);

      const resolved = await getHandoffByRawToken(rawToken!);
      expect(resolved?.id).toBe(handoff.id);

      const guessedToken = generatePublicToken();
      const resolvedWithGuess = await getHandoffByRawToken(guessedToken);
      expect(resolvedWithGuess).toBeNull();
    });

    it("unknown/malformed token resolves to null, never throws", async () => {
      await expect(getHandoffByRawToken("not-a-real-token")).resolves.toBeNull();
      await expect(getHandoffByRawToken("")).resolves.toBeNull();
    });
  });

  describe("date validation", () => {
    it("accepts today", () => expect(() => parseRequestedDeliveryDate(TODAY)).not.toThrow());
    it("accepts a future date", () => expect(() => parseRequestedDeliveryDate(TOMORROW)).not.toThrow());
    it("rejects a past date", () => expect(() => parseRequestedDeliveryDate(YESTERDAY)).toThrow(DeliveryHandoffError));
    it("rejects malformed input", () => expect(() => parseRequestedDeliveryDate("not-a-date")).toThrow(DeliveryHandoffError));
    it("rejects an out-of-range calendar date", () => expect(() => parseRequestedDeliveryDate("2026-02-30")).toThrow(DeliveryHandoffError));
    it("rejects empty/undefined/null input", () => {
      expect(() => parseRequestedDeliveryDate("")).toThrow(DeliveryHandoffError);
      expect(() => parseRequestedDeliveryDate(undefined)).toThrow(DeliveryHandoffError);
      expect(() => parseRequestedDeliveryDate(null)).toThrow(DeliveryHandoffError);
    });
  });

  describe("POST ordering — persist before mirror, mirror before redirect", () => {
    it("persists requestedDeliveryDate locally even when the Shopify mirror fails, and never returns a redirect target", async () => {
      mockMirror.mockRejectedValueOnce(new Error("ACCESS_DENIED"));
      const { handoff } = await createDeliveryDateHandoff({ shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`, createdById: userId });
      createdHandoffIds.push(handoff.id);

      await expect(submitRequestedDeliveryDate(handoff, TOMORROW)).rejects.toThrow(DeliveryHandoffError);

      const reloaded = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      expect(reloaded.requestedDeliveryDate?.toISOString().slice(0, 10)).toBe(TOMORROW);
      expect(reloaded.status).toBe("ERROR");
      expect(reloaded.mirrorErrorCode).toBeTruthy();
    });

    it("marks status MIRRORED and returns the Shopify invoiceUrl as the redirect target on success", async () => {
      const { handoff } = await createDeliveryDateHandoff({ shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`, createdById: userId });
      createdHandoffIds.push(handoff.id);

      const result = await submitRequestedDeliveryDate(handoff, TOMORROW);

      expect(result.redirectUrl).toBe("https://test-shop.myshopify.com/12345/invoices/abc");
      const reloaded = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      expect(reloaded.status).toBe("MIRRORED");
      expect(reloaded.lastMirrorAt).not.toBeNull();
    });

    it("never calls the Shopify mirror at all when the date itself is invalid", async () => {
      const { handoff } = await createDeliveryDateHandoff({ shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`, createdById: userId });
      createdHandoffIds.push(handoff.id);

      await expect(submitRequestedDeliveryDate(handoff, "not-a-date")).rejects.toThrow(DeliveryHandoffError);
      expect(mockMirror).not.toHaveBeenCalled();
    });
  });

  describe("security — opaque token, server-authoritative target", () => {
    it("the redirect target is derived exclusively from server-stored data — nothing in the caller's input can influence it", async () => {
      // submitRequestedDeliveryDate's signature itself proves this: it accepts
      // only (handoff, rawDateInput) — there is no provider/redirect/next/
      // payment_url parameter to tamper with at all. This test confirms the
      // resolved target matches the mocked invoiceUrl regardless of what the
      // date-string input looks like beyond being a valid date.
      const { handoff } = await createDeliveryDateHandoff({ shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`, createdById: userId });
      createdHandoffIds.push(handoff.id);
      mockMirror.mockResolvedValueOnce({ invoiceUrl: "https://test-shop.myshopify.com/999/invoices/xyz" });

      const result = await submitRequestedDeliveryDate(handoff, TOMORROW);
      expect(result.redirectUrl).toBe("https://test-shop.myshopify.com/999/invoices/xyz");
    });
  });

  describe("idempotency", () => {
    it("resubmitting the same date twice keeps exactly one Activity, no duplicate handoff row", async () => {
      const profile = await createTestCustomerProfile();
      const { handoff } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        customerProfileId: profile.id,
        createdById: userId,
      });
      // Not pushed to createdHandoffIds — cleanupCustomerProfile(profile.id)
      // below already removes it (DeliveryDateHandoff.customerProfileId is
      // in scope of that helper); pushing it too would just make the
      // shared afterAll's cleanup attempt a harmless but noisy no-op.

      await submitRequestedDeliveryDate(handoff, TOMORROW);
      const afterFirst = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      await submitRequestedDeliveryDate(afterFirst, TOMORROW);

      const activityCount = await prisma.activity.count({
        where: { relatedDeliveryDateHandoffId: handoff.id, type: "DELIVERY_DATE_REQUESTED" },
      });
      expect(activityCount).toBe(1);

      const handoffCount = await prisma.deliveryDateHandoff.count({ where: { id: handoff.id } });
      expect(handoffCount).toBe(1);

      await cleanupCustomerProfile(profile.id);
    });

    it("a genuinely changed date writes a second Activity and replaces the stored date — latest wins", async () => {
      const profile = await createTestCustomerProfile();
      const { handoff } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        customerProfileId: profile.id,
        createdById: userId,
      });
      // Not pushed to createdHandoffIds — see the identical note above.
      const laterDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      await submitRequestedDeliveryDate(handoff, TOMORROW);
      const afterFirst = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      await submitRequestedDeliveryDate(afterFirst, laterDate);

      const reloaded = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      expect(reloaded.requestedDeliveryDate?.toISOString().slice(0, 10)).toBe(laterDate);

      const activityCount = await prisma.activity.count({
        where: { relatedDeliveryDateHandoffId: handoff.id, type: "DELIVERY_DATE_REQUESTED" },
      });
      expect(activityCount).toBe(2);

      await cleanupCustomerProfile(profile.id);
    });

    it("never writes an Activity when the handoff has no resolved customerProfileId", async () => {
      const { handoff } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        createdById: userId,
        // customerProfileId intentionally omitted
      });
      createdHandoffIds.push(handoff.id);

      await submitRequestedDeliveryDate(handoff, TOMORROW);

      const activityCount = await prisma.activity.count({ where: { relatedDeliveryDateHandoffId: handoff.id } });
      expect(activityCount).toBe(0);
    });
  });

  describe("Mollie — unsupported path fails closed", () => {
    it("fails closed with a non-retryable error and does not redirect when paymentProvider is MOLLIE", async () => {
      const draftOrderGid = `gid://shopify/DraftOrder/${crypto.randomUUID()}`;
      const created = await createDeliveryDateHandoff({ shopifyDraftOrderGid: draftOrderGid, createdById: userId });
      createdHandoffIds.push(created.handoff.id);
      // Phase A never creates a MOLLIE row itself (createDeliveryDateHandoff
      // always defaults to SHOPIFY) — set it directly to exercise the
      // fail-closed path the way a future Phase B producer eventually would.
      const handoff = await prisma.deliveryDateHandoff.update({
        where: { id: created.handoff.id },
        data: { paymentProvider: "MOLLIE" },
      });

      let caught: unknown;
      try {
        await submitRequestedDeliveryDate(handoff, TOMORROW);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DeliveryHandoffError);
      expect((caught as InstanceType<typeof DeliveryHandoffError>).retryable).toBe(false);
      expect((caught as Error).message).toMatch(/Mollie/i);

      // The mirror still ran (Shopify presentation stays in sync regardless
      // of ultimate payment provider) but the local date is safely stored
      // either way, and the row was never treated as MIRRORED-and-redirectable.
      const reloaded = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      expect(reloaded.requestedDeliveryDate).not.toBeNull();
    });

    it("fails closed when paymentProvider is UNKNOWN (never silently falls back to Shopify)", async () => {
      const draftOrderGid = `gid://shopify/DraftOrder/${crypto.randomUUID()}`;
      const created = await createDeliveryDateHandoff({ shopifyDraftOrderGid: draftOrderGid, createdById: userId });
      createdHandoffIds.push(created.handoff.id);
      const handoff = await prisma.deliveryDateHandoff.update({
        where: { id: created.handoff.id },
        data: { paymentProvider: "UNKNOWN" },
      });

      await expect(submitRequestedDeliveryDate(handoff, TOMORROW)).rejects.toThrow(DeliveryHandoffError);
    });
  });

  describe("backoffice listing", () => {
    it("lists only handoffs resolved to the given customer, newest-updated first", async () => {
      const profile = await createTestCustomerProfile();
      const older = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        customerProfileId: profile.id,
        createdById: userId,
      });
      // Not pushed to createdHandoffIds — cleanupCustomerProfile(profile.id)
      // below already removes both rows.
      await new Promise((r) => setTimeout(r, 5));
      const newer = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        customerProfileId: profile.id,
        createdById: userId,
      });

      const listed = await listDeliveryDateHandoffsForCustomer(profile.id);
      expect(listed.map((h) => h.id)).toEqual([newer.handoff.id, older.handoff.id]);

      await cleanupCustomerProfile(profile.id);
    });

    it("lists across all customers (management view), newest-updated first, with the linked customer included", async () => {
      const profile = await createTestCustomerProfile();
      const linked = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        customerProfileId: profile.id,
        createdById: userId,
      });
      // Not pushed to createdHandoffIds — cleanupCustomerProfile(profile.id)
      // below already removes it (same note as the identical pattern
      // earlier in this file).
      const unlinked = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(unlinked.handoff.id);

      const all = await listAllDeliveryDateHandoffs();
      const linkedRow = all.find((h) => h.id === linked.handoff.id);
      const unlinkedRow = all.find((h) => h.id === unlinked.handoff.id);

      expect(linkedRow?.customerProfile?.id).toBe(profile.id);
      expect(unlinkedRow?.customerProfile).toBeNull();

      await cleanupCustomerProfile(profile.id);
    });
  });

  describe("customer matching — read-only, never fabricates a CustomerProfile", () => {
    it("resolves to an existing CustomerProfile's id when the Shopify Customer GID matches one", async () => {
      const profile = await createTestCustomerProfile();
      const resolved = await resolveCustomerProfileIdForShopifyGid(profile.shopifyCustomerGid);
      expect(resolved).toBe(profile.id);
      await cleanupCustomerProfile(profile.id);
    });

    it("returns null for a Shopify Customer GID with no matching CustomerProfile — never creates one", async () => {
      const gid = `gid://shopify/Customer/${crypto.randomUUID()}`;
      const before = await prisma.customerProfile.count();
      const resolved = await resolveCustomerProfileIdForShopifyGid(gid);
      const after = await prisma.customerProfile.count();

      expect(resolved).toBeNull();
      expect(after).toBe(before);
    });

    it("returns null for an absent/undefined Shopify Customer GID", async () => {
      expect(await resolveCustomerProfileIdForShopifyGid(undefined)).toBeNull();
      expect(await resolveCustomerProfileIdForShopifyGid(null)).toBeNull();
      expect(await resolveCustomerProfileIdForShopifyGid("")).toBeNull();
    });

    it("a handoff created without a matching customer stays unlinked, not fabricated", async () => {
      const unknownGid = `gid://shopify/Customer/${crypto.randomUUID()}`;
      const resolved = await resolveCustomerProfileIdForShopifyGid(unknownGid);
      const { handoff } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        customerProfileId: resolved,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);
      expect(handoff.customerProfileId).toBeNull();
    });
  });

  describe("token lifecycle — regeneration", () => {
    it("issues a new token that resolves, while the old token stops resolving — same row, other fields untouched", async () => {
      const { handoff, rawToken: originalToken } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);
      await submitRequestedDeliveryDate(handoff, TOMORROW);

      const { handoff: regenerated, rawToken: newToken } = await regeneratePublicToken(handoff.id, userId);

      expect(newToken).not.toBe(originalToken);
      expect(regenerated.id).toBe(handoff.id);
      // Same row — requestedDeliveryDate/status survive the regeneration.
      expect(regenerated.requestedDeliveryDate?.toISOString().slice(0, 10)).toBe(TOMORROW);
      expect(regenerated.status).toBe("MIRRORED");

      await expect(getHandoffByRawToken(originalToken!)).resolves.toBeNull();
      const resolved = await getHandoffByRawToken(newToken);
      expect(resolved?.id).toBe(handoff.id);

      const total = await prisma.deliveryDateHandoff.count({ where: { id: handoff.id } });
      expect(total).toBe(1);

      const audit = await prisma.auditEvent.findFirst({
        where: { entityId: handoff.id, action: "delivery_handoff.token_regenerated" },
      });
      expect(audit).not.toBeNull();
    });

    it("throws (mapped to 404 by the route layer via Prisma's own not-found error) for an unknown handoff id", async () => {
      await expect(regeneratePublicToken("does-not-exist", userId)).rejects.toThrow();
    });
  });

  describe("no Shopify mutation during creation or customer resolution", () => {
    it("createDeliveryDateHandoff never calls the Shopify mirror", async () => {
      mockMirror.mockClear();
      const { handoff } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);
      expect(mockMirror).not.toHaveBeenCalled();
    });

    it("resolveCustomerProfileIdForShopifyGid never calls the Shopify mirror (it is a local DB read only)", async () => {
      mockMirror.mockClear();
      await resolveCustomerProfileIdForShopifyGid(`gid://shopify/Customer/${crypto.randomUUID()}`);
      expect(mockMirror).not.toHaveBeenCalled();
    });

    it("regeneratePublicToken never calls the Shopify mirror", async () => {
      const { handoff } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);
      mockMirror.mockClear();
      await regeneratePublicToken(handoff.id, userId);
      expect(mockMirror).not.toHaveBeenCalled();
    });
  });

  // Phase 6B — Order-based handoff foundation. No staff UI, no webhook,
  // no automatic eligibility yet: these tests exercise the new service
  // functions directly, the same way the Draft-based functions were
  // originally proven before any UI/route ever called them.
  describe("Order-based handoff — data model, uniqueness, idempotency", () => {
    it("creates an Order handoff with commerceObjectType SHOPIFY_ORDER, shopifyOrderGid set, shopifyDraftOrderGid null", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      const { handoff, rawToken } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: orderGid,
        publicReference: "#1234",
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);

      expect(rawToken).toBeTruthy();
      expect(handoff.commerceObjectType).toBe("SHOPIFY_ORDER");
      expect(handoff.shopifyOrderGid).toBe(orderGid);
      expect(handoff.shopifyDraftOrderGid).toBeNull();
      expect(handoff.externalId).toBe(orderGid);
      expect(handoff.publicReference).toBe("#1234");
      expect(handoff.status).toBe("PENDING");
      expect(handoff.paymentProvider).toBe("UNKNOWN");

      const audit = await prisma.auditEvent.findFirst({ where: { entityId: handoff.id, action: "delivery_handoff.created" } });
      expect(audit).not.toBeNull();
    });

    it("historical Draft rows default to commerceObjectType SHOPIFY_DRAFT_ORDER, with shopifyOrderGid/publicReference null", async () => {
      const { handoff } = await createDeliveryDateHandoff({
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);

      expect(handoff.commerceObjectType).toBe("SHOPIFY_DRAFT_ORDER");
      expect(handoff.shopifyOrderGid).toBeNull();
      expect(handoff.publicReference).toBeNull();
    });

    it("is idempotent per (sourceSystem, externalId) — a repeat create for the same Order returns the existing row, no new raw token, no duplicate", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      const first = await createOrGetOrderDeliveryHandoff({ shopifyOrderGid: orderGid, createdById: userId });
      createdHandoffIds.push(first.handoff.id);

      const second = await createOrGetOrderDeliveryHandoff({ shopifyOrderGid: orderGid, createdById: userId });

      expect(second.handoff.id).toBe(first.handoff.id);
      expect(second.rawToken).toBeNull();

      const count = await prisma.deliveryDateHandoff.count({ where: { externalId: orderGid } });
      expect(count).toBe(1);
    });

    it("a Draft handoff and an Order handoff for numerically-identical-looking GIDs never collide — different externalId strings", async () => {
      const suffix = crypto.randomUUID();
      const draft = await createDeliveryDateHandoff({ shopifyDraftOrderGid: `gid://shopify/DraftOrder/${suffix}`, createdById: userId });
      createdHandoffIds.push(draft.handoff.id);
      const order = await createOrGetOrderDeliveryHandoff({ shopifyOrderGid: `gid://shopify/Order/${suffix}`, createdById: userId });
      createdHandoffIds.push(order.handoff.id);

      expect(draft.handoff.id).not.toBe(order.handoff.id);
      expect(draft.handoff.commerceObjectType).toBe("SHOPIFY_DRAFT_ORDER");
      expect(order.handoff.commerceObjectType).toBe("SHOPIFY_ORDER");
    });

    it("never fabricates a CustomerProfile and never accepts a client-supplied customerProfileId beyond what the caller resolved", async () => {
      const before = await prisma.customerProfile.count();
      const { handoff } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        createdById: userId,
        // customerProfileId intentionally omitted
      });
      createdHandoffIds.push(handoff.id);

      expect(handoff.customerProfileId).toBeNull();
      const after = await prisma.customerProfile.count();
      expect(after).toBe(before);
    });

    it("normalizes publicReference — trims whitespace, collapses whitespace-only to null, caps length", async () => {
      const padded = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        publicReference: "  #1234  ",
        createdById: userId,
      });
      createdHandoffIds.push(padded.handoff.id);
      expect(padded.handoff.publicReference).toBe("#1234");

      const blank = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        publicReference: "   ",
        createdById: userId,
      });
      createdHandoffIds.push(blank.handoff.id);
      expect(blank.handoff.publicReference).toBeNull();

      const empty = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        publicReference: "",
        createdById: userId,
      });
      createdHandoffIds.push(empty.handoff.id);
      expect(empty.handoff.publicReference).toBeNull();

      const tooLong = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        publicReference: "#" + "1".repeat(100),
        createdById: userId,
      });
      createdHandoffIds.push(tooLong.handoff.id);
      expect(tooLong.handoff.publicReference).toHaveLength(64);
    });
  });

  describe("Order-based handoff — submit behavior (no payment redirect)", () => {
    it("marks status MIRRORED, calls the Order mirror (never the Draft mirror), and returns only requestedDeliveryDate — no redirectUrl at all", async () => {
      const { handoff } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);

      const result = await submitRequestedDeliveryDateForOrder(handoff, TOMORROW);

      expect(result).toEqual({ requestedDeliveryDate: TOMORROW });
      expect("redirectUrl" in result).toBe(false);
      expect(mockOrderMirror).toHaveBeenCalledWith(handoff.shopifyOrderGid, TOMORROW);
      expect(mockMirror).not.toHaveBeenCalled();

      const reloaded = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      expect(reloaded.status).toBe("MIRRORED");
      expect(reloaded.lastMirrorAt).not.toBeNull();
    });

    it("persists requestedDeliveryDate locally even when the Order mirror fails, and stays retryable", async () => {
      mockOrderMirror.mockRejectedValueOnce(new Error("ACCESS_DENIED"));
      const { handoff } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);

      const error = await submitRequestedDeliveryDateForOrder(handoff, TOMORROW).catch((e) => e);
      expect(error).toBeInstanceOf(DeliveryHandoffError);
      expect((error as InstanceType<typeof DeliveryHandoffError>).retryable).toBe(true);

      const reloaded = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      expect(reloaded.requestedDeliveryDate?.toISOString().slice(0, 10)).toBe(TOMORROW);
      expect(reloaded.status).toBe("ERROR");
      expect(reloaded.mirrorErrorCode).toBeTruthy();
    });

    it("never calls the Order mirror at all when the date itself is invalid", async () => {
      const { handoff } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);

      await expect(submitRequestedDeliveryDateForOrder(handoff, "not-a-date")).rejects.toThrow(DeliveryHandoffError);
      expect(mockOrderMirror).not.toHaveBeenCalled();
    });

    it("a genuinely changed date writes a second Activity; resubmitting the same date keeps exactly one", async () => {
      const profile = await createTestCustomerProfile();
      const { handoff } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        customerProfileId: profile.id,
        createdById: userId,
      });
      // Not pushed to createdHandoffIds — cleanupCustomerProfile below already removes it.

      await submitRequestedDeliveryDateForOrder(handoff, TOMORROW);
      const afterFirst = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      await submitRequestedDeliveryDateForOrder(afterFirst, TOMORROW);

      let activityCount = await prisma.activity.count({
        where: { relatedDeliveryDateHandoffId: handoff.id, type: "DELIVERY_DATE_REQUESTED" },
      });
      expect(activityCount).toBe(1);

      const laterDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const afterSecond = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      await submitRequestedDeliveryDateForOrder(afterSecond, laterDate);

      activityCount = await prisma.activity.count({
        where: { relatedDeliveryDateHandoffId: handoff.id, type: "DELIVERY_DATE_REQUESTED" },
      });
      expect(activityCount).toBe(2);

      await cleanupCustomerProfile(profile.id);
    });

    it("throws a clear, non-retryable error if a SHOPIFY_ORDER row somehow has no shopifyOrderGid (data-integrity guard)", async () => {
      const { handoff } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);
      // submitRequestedDeliveryDateForOrder always re-persists/re-reads via
      // Prisma rather than trusting the caller's in-memory object for the
      // GID field, so the DB row itself — not a locally mutated copy —
      // must be corrupted to exercise this guard.
      const corrupted = await prisma.deliveryDateHandoff.update({ where: { id: handoff.id }, data: { shopifyOrderGid: null } });

      const error = await submitRequestedDeliveryDateForOrder(corrupted, TOMORROW).catch((e) => e);
      expect(error).toBeInstanceOf(DeliveryHandoffError);
      expect((error as InstanceType<typeof DeliveryHandoffError>).retryable).toBe(false);
      expect(mockOrderMirror).not.toHaveBeenCalled();
    });
  });
});

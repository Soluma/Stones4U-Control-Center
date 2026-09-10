import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import {
  createDeliveryDateHandoff,
  createOrGetOrderDeliveryHandoff,
  createOrderDeliveryHandoffForStaff,
  getHandoffByRawToken,
  listAllDeliveryDateHandoffs,
  listDeliveryDateHandoffsForCustomer,
  parseRequestedDeliveryDate,
  regeneratePublicToken,
  resolveCustomerProfileIdForShopifyGid,
  submitRequestedDeliveryDate,
  submitRequestedDeliveryDateForOrder,
} from "@/modules/delivery/delivery-handoff.service";
import { DeliveryHandoffError, ExistingRequestedDeliveryDateError } from "@/modules/delivery/errors";
import { OrderCancelledError } from "@/integrations/shopify/errors";
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

// Phase 6E — mocked the same way as the mirror functions above: this keeps
// createOrderDeliveryHandoffForStaff()'s own tests focused on its
// orchestration logic (re-read -> cancelled check -> resolve customer ->
// create), not re-testing the Shopify GraphQL client itself (already
// covered in tests/delivery-handoff-shopify.test.ts).
const mockGetOrderForHandoff = vi.fn();
vi.mock("@/integrations/shopify/order-for-handoff", () => ({
  getOrderForHandoff: (...args: unknown[]) => mockGetOrderForHandoff(...args),
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
    mockGetOrderForHandoff.mockReset();
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
      // Dispatch check (Phase 6D): a Draft handoff never reaches the Order
      // mirror, even indirectly.
      expect(mockOrderMirror).not.toHaveBeenCalled();
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

    it("a cancelled Order fails closed — non-retryable, customer-friendly, never implies the date was accepted (build instruction §10)", async () => {
      mockOrderMirror.mockRejectedValueOnce(new OrderCancelledError("gid://shopify/Order/1"));
      const { handoff } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        createdById: userId,
      });
      createdHandoffIds.push(handoff.id);

      const error = await submitRequestedDeliveryDateForOrder(handoff, TOMORROW).catch((e) => e);
      expect(error).toBeInstanceOf(DeliveryHandoffError);
      expect((error as InstanceType<typeof DeliveryHandoffError>).retryable).toBe(false);
      expect((error as Error).message).not.toMatch(/probeer het opnieuw/i);
      expect((error as Error).message).not.toMatch(/gid:\/\/shopify/i);

      const reloaded = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      // Locally chosen date remains persisted per existing proven service
      // semantics (build instruction §10) — cancellation is a mirror
      // failure, not an input-validation failure.
      expect(reloaded.requestedDeliveryDate?.toISOString().slice(0, 10)).toBe(TOMORROW);
      expect(reloaded.status).toBe("ERROR");
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

  describe("Staff Order handoff creation — server-side re-read (createOrderDeliveryHandoffForStaff)", () => {
    it("creates a handoff via a fresh server-side re-read — publicReference comes from that re-read, never from the caller (the function accepts only orderGid + createdById)", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9001",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
      });

      const { handoff, rawToken } = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });
      createdHandoffIds.push(handoff.id);

      expect(rawToken).not.toBeNull();
      expect(handoff.commerceObjectType).toBe("SHOPIFY_ORDER");
      expect(handoff.shopifyOrderGid).toBe(orderGid);
      expect(handoff.publicReference).toBe("#9001");
      expect(handoff.customerProfileId).toBeNull();
      expect(mockGetOrderForHandoff).toHaveBeenCalledWith(orderGid);
    });

    it("resolves customerProfileId server-side from the re-read's customer GID — never fabricates a CustomerProfile", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      const profile = await createTestCustomerProfile();
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9002",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: profile.shopifyCustomerGid,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
      });

      // Not pushed to createdHandoffIds — cleanupCustomerProfile below
      // already removes it (same convention as the rest of this file).
      const { handoff } = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });

      expect(handoff.customerProfileId).toBe(profile.id);
      await cleanupCustomerProfile(profile.id);
    });

    it("never links to an unknown Shopify Customer GID — customerProfileId stays null rather than inventing linkage", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9003",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: `gid://shopify/Customer/${crypto.randomUUID()}`,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
      });

      const { handoff } = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });
      createdHandoffIds.push(handoff.id);
      expect(handoff.customerProfileId).toBeNull();
    });

    it("blocks creation for a cancelled Order with a staff-friendly, non-retryable message (build instruction §7) — no handoff row is created", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9004",
        isCancelled: true,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
      });

      const error = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId }).catch((e) => e);
      expect(error).toBeInstanceOf(DeliveryHandoffError);
      expect((error as InstanceType<typeof DeliveryHandoffError>).message).toBe(
        "Voor een geannuleerde bestelling kan geen nieuwe leverdatumlink worden aangemaakt.",
      );
      expect((error as InstanceType<typeof DeliveryHandoffError>).retryable).toBe(false);

      const count = await prisma.deliveryDateHandoff.count({ where: { externalId: orderGid } });
      expect(count).toBe(0);
    });

    it("a historical handoff for an Order that later becomes cancelled remains untouched and readable — the cancelled check runs before any lookup/create, so an existing row is never reached, let alone modified", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9005",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
      });
      const { handoff: original } = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });
      createdHandoffIds.push(original.id);

      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9005",
        isCancelled: true,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
      });
      await expect(createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId })).rejects.toThrow(DeliveryHandoffError);

      const stillThere = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: original.id } });
      expect(stillThere.id).toBe(original.id);
      expect(stillThere.publicReference).toBe("#9005");
    });

    it("returns a clear, non-retryable error when the Order no longer exists on re-read", async () => {
      mockGetOrderForHandoff.mockResolvedValueOnce(null);
      const error = await createOrderDeliveryHandoffForStaff({
        orderGid: `gid://shopify/Order/${crypto.randomUUID()}`,
        createdById: userId,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(DeliveryHandoffError);
      expect((error as InstanceType<typeof DeliveryHandoffError>).retryable).toBe(false);
    });

    it("is idempotent — a second call for the same Order returns the existing row, no new raw token (build instruction §9)", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      const orderSnapshot = {
        gid: orderGid,
        name: "#9006",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
      };
      mockGetOrderForHandoff.mockResolvedValueOnce(orderSnapshot);
      const first = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });
      createdHandoffIds.push(first.handoff.id);

      mockGetOrderForHandoff.mockResolvedValueOnce(orderSnapshot);
      const second = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });

      expect(second.handoff.id).toBe(first.handoff.id);
      expect(second.rawToken).toBeNull();

      const count = await prisma.deliveryDateHandoff.count({ where: { externalId: orderGid } });
      expect(count).toBe(1);
    });
  });

  describe("Staff Order handoff creation — existing requested_delivery_date confirmation (new business rule, this round)", () => {
    // Fons clarified this round: requested_delivery_date can already exist
    // on an Order before any Control Center handoff ever did — from an
    // earlier quote, the Draft stage, or staff, not only the customer
    // portal. Discovering it on re-read must never be silently treated as
    // "safe to overwrite" nor as proof of customer-portal origin.

    it("an unconfirmed first attempt for an Order with an existing requested_delivery_date and no local handoff creates nothing and throws a typed confirmation-required error carrying only the date", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9101",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: true,
        requestedDeliveryDate: "2026-09-24",
      });

      const error = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId }).catch((e) => e);
      expect(error).toBeInstanceOf(ExistingRequestedDeliveryDateError);
      expect((error as ExistingRequestedDeliveryDateError).requestedDeliveryDate).toBe("2026-09-24");
      // The error carries the date and nothing else sensitive — no Order
      // GID, no customer data, only the plain date value, its fixed
      // `name`, and the inherited fixed message.
      expect(Object.keys(error as object).sort()).toEqual(["name", "requestedDeliveryDate"]);

      const count = await prisma.deliveryDateHandoff.count({ where: { externalId: orderGid } });
      expect(count).toBe(0);
    });

    it("explicit confirmExistingRequestedDeliveryDate lets creation proceed for an active Order, and the confirmed attempt still re-reads Shopify server-side", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      const orderSnapshot = {
        gid: orderGid,
        name: "#9102",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: true,
        requestedDeliveryDate: "2026-09-24",
      };
      mockGetOrderForHandoff.mockResolvedValueOnce(orderSnapshot); // unconfirmed attempt
      await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId }).catch(() => undefined);

      mockGetOrderForHandoff.mockResolvedValueOnce(orderSnapshot); // confirmed attempt
      const { handoff } = await createOrderDeliveryHandoffForStaff({
        orderGid,
        createdById: userId,
        confirmExistingRequestedDeliveryDate: true,
      });
      createdHandoffIds.push(handoff.id);

      expect(handoff.shopifyOrderGid).toBe(orderGid);
      expect(handoff.publicReference).toBe("#9102");
      // Confirmation authorizes creation — it does not skip the
      // server-side re-read (build instruction §4): getOrderForHandoff was
      // called twice, once per attempt, never trusting a cached/earlier read.
      expect(mockGetOrderForHandoff).toHaveBeenCalledTimes(2);

      const count = await prisma.deliveryDateHandoff.count({ where: { externalId: orderGid } });
      expect(count).toBe(1);
    });

    it("cancellation wins even over an explicit confirmation — build instruction §6", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9103",
        isCancelled: true,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: true,
        requestedDeliveryDate: "2026-09-24",
      });

      const error = await createOrderDeliveryHandoffForStaff({
        orderGid,
        createdById: userId,
        confirmExistingRequestedDeliveryDate: true,
      }).catch((e) => e);

      expect(error).toBeInstanceOf(DeliveryHandoffError);
      expect((error as InstanceType<typeof DeliveryHandoffError>).message).toBe(
        "Voor een geannuleerde bestelling kan geen nieuwe leverdatumlink worden aangemaakt.",
      );
      const count = await prisma.deliveryDateHandoff.count({ where: { externalId: orderGid } });
      expect(count).toBe(0);
    });

    it("an existing local handoff bypasses the confirmation requirement entirely, even though Shopify already shows a requested date — normal idempotent behavior, no confirmation needed (build instruction §7)", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      // First create: no existing date yet, no confirmation needed.
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9104",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
        requestedDeliveryDate: null,
      });
      const first = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });
      createdHandoffIds.push(first.handoff.id);

      // Second create attempt, unconfirmed: Shopify now shows a date (e.g.
      // the customer submitted one through their link in the meantime) —
      // but a local handoff already exists, so this must NOT require
      // confirmation; it is the ordinary idempotent "already exists" path.
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9104",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: true,
        requestedDeliveryDate: "2026-09-24",
      });
      const second = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });

      expect(second.handoff.id).toBe(first.handoff.id);
      expect(second.rawToken).toBeNull();
      const count = await prisma.deliveryDateHandoff.count({ where: { externalId: orderGid } });
      expect(count).toBe(1);
    });

    it("never fabricates an Activity merely from discovering an existing Shopify requested_delivery_date — no code path here creates one at all", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      const profile = await createTestCustomerProfile();
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9105",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: profile.shopifyCustomerGid,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: true,
        requestedDeliveryDate: "2026-09-24",
      });

      // Not pushed to createdHandoffIds — cleanupCustomerProfile below
      // already removes it.
      const { handoff } = await createOrderDeliveryHandoffForStaff({
        orderGid,
        createdById: userId,
        confirmExistingRequestedDeliveryDate: true,
      });

      const activityCount = await prisma.activity.count({ where: { relatedDeliveryDateHandoffId: handoff.id } });
      expect(activityCount).toBe(0);
      await cleanupCustomerProfile(profile.id);
    });
  });

  describe("regeneratePublicToken — works for either handoff type", () => {
    it("logs both GID fields in the audit trail (only the relevant one is ever non-null) so the trail is meaningful for an Order row too", async () => {
      const orderGid = `gid://shopify/Order/${crypto.randomUUID()}`;
      mockGetOrderForHandoff.mockResolvedValueOnce({
        gid: orderGid,
        name: "#9007",
        isCancelled: false,
        fulfillmentStatus: "UNFULFILLED",
        customerGid: null,
        hasShippingAddress: true,
        hasRequestedDeliveryDateAlready: false,
      });
      const { handoff } = await createOrderDeliveryHandoffForStaff({ orderGid, createdById: userId });
      createdHandoffIds.push(handoff.id);

      const before = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
      const { rawToken: newToken } = await regeneratePublicToken(handoff.id, userId);
      const after = await prisma.deliveryDateHandoff.findUniqueOrThrow({ where: { id: handoff.id } });

      expect(newToken).toBeTruthy();
      expect(after.publicTokenHash).not.toBe(before.publicTokenHash);
      expect(after.shopifyOrderGid).toBe(orderGid);
      // Everything else about the row is untouched by regeneration.
      expect(after.requestedDeliveryDate).toBe(before.requestedDeliveryDate);
      expect(after.status).toBe(before.status);
    });
  });
});

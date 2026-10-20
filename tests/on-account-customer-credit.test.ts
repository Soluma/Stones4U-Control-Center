import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  store: new Map<string, { creditAllowed: string | null; termDays: string | null }>(),
  writes: [] as unknown[],
}));
vi.mock("@/integrations/shopify/on-account-read", () => ({
  readCustomerCreditRaw: vi.fn(async (gid: string) => {
    const c = fake.store.get(gid);
    return c ? { customerId: gid, displayName: "K", email: "k@example.com", ...c } : null;
  }),
}));
vi.mock("@/integrations/shopify/on-account", () => ({
  writeCustomerCredit: vi.fn(async (gid: string, input: { creditAllowed: boolean; termDays: number | null }) => {
    fake.writes.push({ gid, input });
    fake.store.set(gid, { creditAllowed: String(input.creditAllowed), termDays: input.termDays === null ? null : String(input.termDays) });
  }),
}));

import { prisma } from "@/platform/db/prisma";
import { CustomerCreditError, getCustomerCredit, setCustomerCredit } from "@/modules/on-account/customer-credit.service";
import { cleanupUser, createTestCustomerProfile, createTestUser } from "./fixtures";

const cleanup: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});
beforeEach(() => {
  fake.writes = [];
});

async function setup(initial: { creditAllowed: string | null; termDays: string | null }) {
  const profile = await createTestCustomerProfile();
  const admin = await createTestUser({ role: "ADMIN" });
  fake.store.set(profile.shopifyCustomerGid, initial);
  cleanup.push(() => prisma.customerProfile.delete({ where: { id: profile.id } }).catch(() => undefined), () => cleanupUser(admin.id));
  const actor = { id: admin.id, email: admin.email, name: admin.name, role: admin.role } as never;
  return { profile, actor };
}

describe("customer credit settings (Shopify customer metafields)", () => {
  it("reads the rules: not allowed / allowed with default 30 / allowed with own term", async () => {
    const a = await setup({ creditAllowed: null, termDays: "45" });
    expect(await getCustomerCredit(a.profile.id)).toMatchObject({ creditAllowed: false, effectiveTermDays: null });
    const b = await setup({ creditAllowed: "true", termDays: null });
    expect(await getCustomerCredit(b.profile.id)).toMatchObject({ creditAllowed: true, effectiveTermDays: 30, storedTermDays: null });
    const c = await setup({ creditAllowed: "true", termDays: "14" });
    expect(await getCustomerCredit(c.profile.id)).toMatchObject({ creditAllowed: true, effectiveTermDays: 14, storedTermDays: 14 });
  });

  it("an invalid stored term is shown as invalid, never as 30", async () => {
    const a = await setup({ creditAllowed: "true", termDays: "dertig" });
    expect(await getCustomerCredit(a.profile.id)).toMatchObject({ effectiveTermDays: null, invalidStoredValue: "dertig" });
  });

  it("writes, verifies and audits (before/after, no personal data)", async () => {
    const a = await setup({ creditAllowed: null, termDays: null });
    const view = await setCustomerCredit(a.profile.id, { creditAllowed: true, termDays: 45 }, a.actor);
    expect(view).toMatchObject({ creditAllowed: true, effectiveTermDays: 45 });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "customer_credit.updated", entityId: a.profile.shopifyCustomerGid } });
    expect(audit.metadata).toMatchObject({ before: { creditAllowed: null, termDays: null }, after: { creditAllowed: "true", termDays: "45" } });
    expect(JSON.stringify(audit.metadata)).not.toContain("k@example.com");
    // clearing the term -> default 30 again
    expect(await setCustomerCredit(a.profile.id, { creditAllowed: true, termDays: null }, a.actor)).toMatchObject({ effectiveTermDays: 30, storedTermDays: null });
  });

  it("rejects a nonsense term before touching Shopify", async () => {
    const a = await setup({ creditAllowed: null, termDays: null });
    for (const termDays of [0, 400, 12.5]) {
      await expect(setCustomerCredit(a.profile.id, { creditAllowed: true, termDays }, a.actor)).rejects.toBeInstanceOf(CustomerCreditError);
    }
    expect(fake.writes).toHaveLength(0);
  });
});

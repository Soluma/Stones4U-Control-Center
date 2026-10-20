import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Op rekening v1 — central service against the real test database and an
// in-memory FAKE Shopify that behaves like stones4u-dev did in fase 0:
// paymentTermsCreate REPLACES existing terms, a second delete says "Could not
// find payment terms", orderInvoiceSend mails again on every call and adds a
// "sent invoice" event, draft metafields do not exist on the order unless set.

type FakeOrder = {
  id: string;
  name: string;
  tags: string[];
  cancelledAt: string | null;
  financial: string;
  total: string;
  outstanding: string;
  email: string | null;
  appName: string;
  terms: { id: string; type: string; dueAt: string | null } | null;
  metafields: { termDays: string | null; handedOverAt: string | null; invoiceSentAt: string | null };
  attributes: { termDays: string | null; handedOverAt: string | null };
  events: { createdAt: string; message: string }[];
};

const shop = vi.hoisted(() => ({
  orders: new Map<string, FakeOrder>(),
  calls: [] as { op: string; args: unknown }[],
  fail: {} as Record<string, number | "uncertain">,
  seq: 1,
}));

function snapshotOf(o: FakeOrder) {
  return {
    id: o.id,
    name: o.name,
    createdAt: "2026-10-20T08:00:00Z",
    tags: [...o.tags],
    cancelledAt: o.cancelledAt,
    displayFinancialStatus: o.financial,
    displayFulfillmentStatus: "UNFULFILLED",
    total: o.total,
    outstanding: o.outstanding,
    email: o.email,
    customerId: "gid://shopify/Customer/1",
    customerEmail: o.email,
    appName: o.appName,
    paymentTerms: o.terms
      ? { id: o.terms.id, type: o.terms.type, name: o.terms.type, overdue: false, schedules: o.terms.dueAt ? [{ id: "s", dueAt: o.terms.dueAt, completedAt: null }] : [] }
      : null,
    metafields: { ...o.metafields },
    attributes: { ...o.attributes },
    invoiceEvents: o.events.filter((e) => /sent invoice/.test(e.message)).slice().reverse(),
  };
}

/** Real network latency, so concurrent callers genuinely interleave. */
const latency = () => new Promise((resolve) => setTimeout(resolve, 3 + Math.floor(Math.random() * 6)));

function maybeFail(op: string) {
  const f = shop.fail[op];
  if (f === "uncertain") {
    delete shop.fail[op];
    throw new Error("socket hang up (fake)");
  }
  if (typeof f === "number" && f > 0) {
    shop.fail[op] = f - 1;
    throw new Error(`${op} failed (fake)`);
  }
}

vi.mock("@/integrations/shopify/on-account-read", () => ({
  readOnAccountOrder: vi.fn(async (gid: string) => {
    await latency();
    shop.calls.push({ op: "read", args: gid });
    maybeFail("read");
    const o = shop.orders.get(gid);
    return o ? snapshotOf(o) : null;
  }),
}));

vi.mock("@/integrations/shopify/on-account", () => ({
  deleteOrderPaymentTerms: vi.fn(async (termsId: string) => {
    shop.calls.push({ op: "delete", args: termsId });
    maybeFail("delete");
    for (const o of shop.orders.values()) {
      if (o.terms?.id === termsId) {
        o.terms = null;
        return { outcome: "DELETED" };
      }
    }
    return { outcome: "ALREADY_GONE" };
  }),
  createFixedPaymentTerms: vi.fn(async (gid: string, dueAt: Date) => {
    await latency();
    shop.calls.push({ op: "create", args: { gid, dueAt: dueAt.toISOString() } });
    maybeFail("create");
    const o = shop.orders.get(gid)!;
    o.terms = { id: `gid://shopify/PaymentTerms/${shop.seq++}`, type: "FIXED", dueAt: dueAt.toISOString().replace(".000Z", "Z") };
    return { paymentTermsId: o.terms.id, dueAt: o.terms.dueAt };
  }),
  updateToFixedPaymentTerms: vi.fn(async (termsId: string, dueAt: Date) => {
    shop.calls.push({ op: "update", args: { termsId, dueAt: dueAt.toISOString() } });
    maybeFail("update");
    for (const o of shop.orders.values()) {
      if (o.terms?.id === termsId) {
        o.terms = { id: termsId, type: "FIXED", dueAt: dueAt.toISOString().replace(".000Z", "Z") };
        return { paymentTermsId: termsId, dueAt: o.terms.dueAt };
      }
    }
    throw new Error("terms not found (fake)");
  }),
  sendOrderInvoice: vi.fn(async (gid: string, to: string, message: string) => {
    await latency();
    shop.calls.push({ op: "invoice", args: { gid, to, message } });
    const o = shop.orders.get(gid)!;
    if (shop.fail.invoice === "uncertain") {
      delete shop.fail.invoice;
      o.events.push({ createdAt: new Date().toISOString(), message: `CRM sent invoice ${o.name} to Klant (${to})` }); // it DID go out
      throw new Error("timeout after send (fake)");
    }
    if (shop.fail.invoiceLost === "uncertain") {
      delete shop.fail.invoiceLost;
      throw new Error("timeout, nothing visible (fake)");
    }
    if (o.financial === "PAID") return { outcome: "NOT_SENT", userErrors: [{ field: null, message: "No outstanding balance exist", code: "ORDER_INVOICE_SEND_UNSUCCESSFUL" }] };
    o.events.push({ createdAt: new Date().toISOString(), message: `CRM sent invoice ${o.name} to Klant (${to})` });
    return { outcome: "SENT" };
  }),
  setOrderInvoiceSentAt: vi.fn(async (gid: string, at: Date) => {
    shop.calls.push({ op: "marker", args: gid });
    maybeFail("marker");
    shop.orders.get(gid)!.metafields.invoiceSentAt = at.toISOString();
  }),
}));

import { prisma } from "@/platform/db/prisma";
import {
  markOnAccountOrderPaid,
  reconcileOnAccountOrder,
  recordDelivery,
  registerOnAccountOrder,
  recordManualDelivery,
  requestInvoiceNow,
  resolveReview,
  runOnAccountWorker,
} from "@/modules/on-account/on-account.service";
import { noteOnAccountFromWebhook } from "@/modules/on-account/webhook-hook";

const created: string[] = [];
function newOrder(overrides: Partial<FakeOrder> = {}): FakeOrder {
  const n = Math.floor(Math.random() * 1e12);
  const o: FakeOrder = {
    id: `gid://shopify/Order/${n}`,
    name: `#T${n % 10000}`,
    tags: ["op-rekening"],
    cancelledAt: null,
    financial: "PENDING",
    total: "48.40",
    outstanding: "48.40",
    email: "klant@example.com",
    appName: "Source2POS Production",
    terms: { id: `gid://shopify/PaymentTerms/temp-${n}`, type: "FULFILLMENT", dueAt: null },
    metafields: { termDays: "30", handedOverAt: null, invoiceSentAt: null },
    attributes: { termDays: "30", handedOverAt: null },
    events: [],
    ...overrides,
  };
  shop.orders.set(o.id, o);
  created.push(o.id);
  return o;
}
const ops = (op: string) => shop.calls.filter((c) => c.op === op);
const rowOf = (gid: string) => prisma.onAccountOrder.findUniqueOrThrow({ where: { shopifyOrderGid: gid } });

beforeEach(() => {
  shop.calls = [];
  shop.fail = {};
});
afterAll(async () => {
  await prisma.onAccountOrder.deleteMany({ where: { shopifyOrderGid: { in: created } } });
  await prisma.auditEvent.deleteMany({ where: { entityType: "OnAccountOrder" } });
});

describe("registration and the clean resting state", () => {
  it("removes the temporary FULFILLMENT terms and rests in WAITING_FOR_DELIVERY (no due date, no invoice)", async () => {
    const o = newOrder();
    const r = await registerOnAccountOrder(o.id, "WEBHOOK");
    expect(r).toMatchObject({ registered: true, state: "WAITING_FOR_DELIVERY" });
    expect(o.terms).toBeNull();
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ sourceApp: "SOURCE2POS", termDays: 30, dueAt: null, invoiceSentAt: null });
    expect(ops("invoice")).toHaveLength(0);
    expect(ops("create")).toHaveLength(0);
  });

  it("ignores an order without the op-rekening tag (no row)", async () => {
    const o = newOrder({ tags: [] });
    expect(await registerOnAccountOrder(o.id, "WEBHOOK")).toEqual({ registered: false, reason: "NOT_ON_ACCOUNT" });
    expect(await prisma.onAccountOrder.findUnique({ where: { shopifyOrderGid: o.id } })).toBeNull();
  });

  it("cleanup failure is a real, retryable state: PENDING_TEMP_TERMS; the retry only deletes — never recreates", async () => {
    const o = newOrder();
    shop.fail.delete = 1;
    const r = await registerOnAccountOrder(o.id, "WEBHOOK");
    expect(r).toMatchObject({ state: "PENDING_TEMP_TERMS" });
    const failed = await rowOf(o.id);
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt).not.toBeNull();
    // registering again (e.g. the webhook is redelivered) does not create a second row
    await registerOnAccountOrder(o.id, "WEBHOOK");
    expect(await prisma.onAccountOrder.count({ where: { shopifyOrderGid: o.id } })).toBe(1);
    const final = await reconcileOnAccountOrder(failed.id);
    expect(final.state).toBe("WAITING_FOR_DELIVERY");
    expect(o.terms).toBeNull();
    expect(ops("create")).toHaveLength(0);
  });

  it("the attribute is the atomic fallback when the order metafield was never set; a conflict needs review", async () => {
    const a = newOrder({ metafields: { termDays: null, handedOverAt: null, invoiceSentAt: null }, attributes: { termDays: "45", handedOverAt: null } });
    await registerOnAccountOrder(a.id, "WEBHOOK");
    expect((await rowOf(a.id)).termDays).toBe(45);
    const b = newOrder({ metafields: { termDays: "30", handedOverAt: null, invoiceSentAt: null }, attributes: { termDays: "45", handedOverAt: null } });
    await registerOnAccountOrder(b.id, "WEBHOOK");
    expect(await rowOf(b.id)).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "TERM_DAYS_INVALID" });
  });

  it("missing term -> MANUAL_REVIEW, never silently 30", async () => {
    const o = newOrder({ metafields: { termDays: null, handedOverAt: null, invoiceSentAt: null }, attributes: { termDays: null, handedOverAt: null } });
    await registerOnAccountOrder(o.id, "WEBHOOK");
    expect(await rowOf(o.id)).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "TERM_DAYS_MISSING" });
  });

  it("other terms before delivery (e.g. Due on receipt) are never touched automatically", async () => {
    const o = newOrder({ terms: { id: "gid://shopify/PaymentTerms/r1", type: "RECEIPT", dueAt: "2026-10-20T08:00:00Z" } });
    await registerOnAccountOrder(o.id, "WEBHOOK");
    expect(await rowOf(o.id)).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "UNEXPECTED_PAYMENT_TERMS" });
    expect(ops("delete")).toHaveLength(0);
  });
});

describe("delivery -> FIXED dueAt -> exactly one invoice", () => {
  it("counter handover: term starts at handed_over_at; dueAt = date + N at 23:59:59 Amsterdam; one invoice + marker", async () => {
    const o = newOrder({ metafields: { termDays: "30", handedOverAt: "2026-10-20T10:00:00Z", invoiceSentAt: null }, attributes: { termDays: "30", handedOverAt: "2026-10-20T10:00:00Z" } });
    const r = await registerOnAccountOrder(o.id, "WEBHOOK");
    expect(r).toMatchObject({ state: "INVOICE_SENT" });
    const row = await rowOf(o.id);
    expect(row.triggerSource).toBe("COUNTER_HANDOVER");
    expect(row.dueAt?.toISOString()).toBe("2026-11-19T22:59:59.000Z");
    expect(o.terms).toMatchObject({ type: "FIXED", dueAt: "2026-11-19T22:59:59Z" });
    expect(ops("invoice")).toHaveLength(1);
    expect((ops("invoice")[0]!.args as { to: string; message: string }).to).toBe("klant@example.com");
    expect((ops("invoice")[0]!.args as { message: string }).message).toContain("19-11-2026");
    expect(o.metafields.invoiceSentAt).not.toBeNull();
    // anything after that is a no-op
    await reconcileOnAccountOrder(row.id);
    await runOnAccountWorker();
    expect(ops("invoice")).toHaveLength(1);
  });

  it("the same delivery event twice: one APPLIED, one DUPLICATE; a different later event is ignored", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    const ev = { orderGid: o.id, triggerSource: "PICKUP_HANDOVER" as const, source: "offerteapp", eventKey: "audit:1", kind: "CUSTOMER_PICKUP_HANDED_OVER", occurredAt: new Date("2026-10-20T10:00:00Z"), actorUserId: null };
    const [a, b] = await Promise.all([recordDelivery(ev), recordDelivery(ev)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["APPLIED", "DUPLICATE"]);
    const later = await recordDelivery({ ...ev, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "manual:x", occurredAt: new Date("2026-10-25T10:00:00Z") });
    expect(later.outcome).toBe("IGNORED_ALREADY_DELIVERED");
    const row = await rowOf(o.id);
    expect(row.deliveredAt?.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(ops("create")).toHaveLength(1);
    expect(ops("invoice")).toHaveLength(1);
    expect(await prisma.onAccountEvent.count({ where: { onAccountOrderId: row.id } })).toBe(2);
  });

  it("FIXED terms already exactly right -> NO-OP (no create, no update)", async () => {
    const o = newOrder({ terms: null });
    await registerOnAccountOrder(o.id, "WEBHOOK");
    o.terms = { id: "gid://shopify/PaymentTerms/pre", type: "FIXED", dueAt: "2026-11-19T22:59:59Z" };
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m1", kind: "MANUAL_DELIVERY", occurredAt: new Date("2026-10-20T10:00:00Z"), actorUserId: null });
    expect(ops("create")).toHaveLength(0);
    expect(ops("update")).toHaveLength(0);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
  });

  it("a FIXED dueAt someone else put on the order is never overwritten (DUE_DATE_CONFLICT)", async () => {
    const o = newOrder({ terms: null });
    await registerOnAccountOrder(o.id, "WEBHOOK");
    o.terms = { id: "gid://shopify/PaymentTerms/other", type: "FIXED", dueAt: "2026-12-31T22:59:59Z" };
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m2", kind: "MANUAL_DELIVERY", occurredAt: new Date("2026-10-20T10:00:00Z"), actorUserId: null });
    expect(await rowOf(o.id)).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "DUE_DATE_CONFLICT" });
    expect(ops("update")).toHaveLength(0);
    expect(ops("invoice")).toHaveLength(0);
  });

  it("two workers at once never send two invoices", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m3", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null, skipReconcile: true });
    const row = await rowOf(o.id);
    await Promise.all([reconcileOnAccountOrder(row.id), reconcileOnAccountOrder(row.id), reconcileOnAccountOrder(row.id)]);
    expect(ops("invoice")).toHaveLength(1);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
  });

  it("three workers that all find the order at TERMS_SET: the claim lets exactly one send", async () => {
    const o = newOrder({ terms: { id: "gid://shopify/PaymentTerms/ours", type: "FIXED", dueAt: "2026-11-19T22:59:59Z" } });
    const row = await prisma.onAccountOrder.create({
      data: {
        shopifyOrderGid: o.id,
        sourceApp: "SOURCE2POS",
        termDays: 30,
        state: "TERMS_SET",
        deliveredAt: new Date("2026-10-20T10:00:00Z"),
        triggerSource: "MANUAL_DELIVERY",
        dueAt: new Date("2026-11-19T22:59:59Z"),
        paymentTermsId: "gid://shopify/PaymentTerms/ours",
        termsSetAt: new Date(),
      },
    });
    await Promise.all([reconcileOnAccountOrder(row.id), reconcileOnAccountOrder(row.id), reconcileOnAccountOrder(row.id)]);
    expect(ops("invoice")).toHaveLength(1);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
  });

  it("send timed out but Shopify shows the 'sent invoice' event -> INVOICE_SENT, no second mail", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.fail.invoice = "uncertain";
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m4", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null });
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    expect(ops("invoice")).toHaveLength(1);
  });

  it("send timed out and nothing visible on Shopify -> MANUAL_REVIEW INVOICE_SEND_UNCERTAIN; never re-sent automatically", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.fail.invoiceLost = "uncertain";
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m5", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null });
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "INVOICE_SEND_UNCERTAIN" });
    await runOnAccountWorker();
    await reconcileOnAccountOrder(row.id);
    expect(ops("invoice")).toHaveLength(1);
    // a human decides: "not sent" -> exactly one new send
    const user = await prisma.user.create({ data: { email: `oa-${Date.now()}@example.com`, name: "T", passwordHash: "x", role: "ADMIN" } });
    await resolveReview(row.id, "RETRY_INVOICE", user.id, "Gecontroleerd in Shopify: niet verstuurd");
    expect(ops("invoice")).toHaveLength(2);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    await prisma.auditEvent.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("Shopify refuses the send because it was paid meanwhile -> PAID", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m6", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null, skipReconcile: true });
    const row = await rowOf(o.id);
    await reconcileOnAccountOrder(row.id); // -> terms set + invoice sent
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    o.financial = "PAID";
    o.outstanding = "0.00";
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("PAID");
  });

  it("partial delivery is never invoiced automatically (MANUAL_REVIEW)", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    const r = await recordDelivery({ orderGid: o.id, triggerSource: "PICKUP_HANDOVER", source: "offerteapp", eventKey: "audit:p", kind: "CUSTOMER_PICKUP_HANDED_OVER", occurredAt: new Date(), actorUserId: null, partial: true });
    expect(r.outcome).toBe("MANUAL_REVIEW");
    expect(ops("create")).toHaveLength(0);
    expect(ops("invoice")).toHaveLength(0);
  });

  it("a delivery event for a cancelled or already paid order is stored and ignored", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    o.cancelledAt = "2026-10-21T10:00:00Z";
    const r = await recordDelivery({ orderGid: o.id, triggerSource: "PICKUP_HANDOVER", source: "offerteapp", eventKey: "audit:c", kind: "CUSTOMER_PICKUP_HANDED_OVER", occurredAt: new Date(), actorUserId: null });
    expect(r.outcome).toBe("IGNORED_NOT_ELIGIBLE");
    expect((await rowOf(o.id)).state).toBe("CANCELLED");
    expect(ops("invoice")).toHaveLength(0);
  });

  it("an event that arrived during MANUAL_REVIEW is applied once the order is fixed", async () => {
    const o = newOrder({ metafields: { termDays: null, handedOverAt: null, invoiceSentAt: null }, attributes: { termDays: null, handedOverAt: null } });
    await registerOnAccountOrder(o.id, "WEBHOOK");
    const ev = { orderGid: o.id, triggerSource: "PICKUP_HANDOVER" as const, source: "offerteapp", eventKey: "audit:r", kind: "CUSTOMER_PICKUP_HANDED_OVER", occurredAt: new Date("2026-10-20T10:00:00Z"), actorUserId: null };
    expect((await recordDelivery(ev)).outcome).toBe("IGNORED_NOT_ELIGIBLE");
    o.metafields.termDays = "14"; // fixed on Shopify
    const user = await prisma.user.create({ data: { email: `oa2-${Date.now()}@example.com`, name: "T", passwordHash: "x", role: "ADMIN" } });
    await resolveReview((await rowOf(o.id)).id, "RETRY_FROM_START", user.id, "termijn aangevuld");
    expect((await rowOf(o.id)).state).toBe("WAITING_FOR_DELIVERY");
    expect((await recordDelivery(ev)).outcome).toBe("APPLIED");
    expect((await rowOf(o.id)).dueAt?.toISOString()).toBe("2026-11-03T22:59:59.000Z");
    await prisma.auditEvent.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe("manual invoice, paid webhook, worker", () => {
  it("'Betaallink nu versturen': term starts now, later pickup ignored, same requestId twice = one mail", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    const req = { orderGid: o.id, requestId: crypto.randomUUID(), requestedBy: { name: "Fons", email: null }, source: "offerteapp-api" };
    const first = await requestInvoiceNow(req);
    expect(first.outcome).toBe("APPLIED");
    expect(first.row?.triggerSource).toBe("MANUAL_INVOICE");
    expect(first.row?.state).toBe("INVOICE_SENT");
    const again = await requestInvoiceNow(req);
    expect(again.outcome).toBe("DUPLICATE");
    const pickup = await recordDelivery({ orderGid: o.id, triggerSource: "PICKUP_HANDOVER", source: "offerteapp", eventKey: "audit:later", kind: "CUSTOMER_PICKUP_HANDED_OVER", occurredAt: new Date(Date.now() + 86_400_000), actorUserId: null });
    expect(pickup.outcome).toBe("IGNORED_ALREADY_DELIVERED");
    expect(ops("invoice")).toHaveLength(1);
  });

  it("orders/paid webhook stops everything", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "true";
    expect(await noteOnAccountFromWebhook("ORDER_PAID", o.id, JSON.stringify({ id: 1, financial_status: "paid" }))).toBe("MARKED_PAID");
    expect((await rowOf(o.id)).state).toBe("PAID");
    const r = await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "after-paid", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null });
    expect(r.outcome).toBe("IGNORED_NOT_ELIGIBLE");
    expect(ops("invoice")).toHaveLength(0);
    delete process.env.ON_ACCOUNT_SERVICE_ENABLED;
  });

  it("markOnAccountOrderPaid confirms with Shopify before moving", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    expect(await markOnAccountOrderPaid(o.id)).toEqual({ updated: false });
    o.financial = "PAID";
    o.outstanding = "0.00";
    expect(await markOnAccountOrderPaid(o.id)).toEqual({ updated: true });
  });

  it("orders/create webhook: records only when tagged and enabled — fast, no Shopify call", async () => {
    const o = newOrder();
    const body = JSON.stringify({ id: 1, tags: "foo, op-rekening" });
    expect(await noteOnAccountFromWebhook("ORDER_CREATED", o.id, body)).toBe("DISABLED");
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "true";
    expect(await noteOnAccountFromWebhook("ORDER_CREATED", o.id, JSON.stringify({ id: 1, tags: "foo" }))).toBe("NOT_ON_ACCOUNT");
    expect(await noteOnAccountFromWebhook("ORDER_CREATED", o.id, body)).toBe("RECORDED");
    expect(await noteOnAccountFromWebhook("ORDER_CREATED", o.id, body)).toBe("ALREADY_KNOWN");
    expect(ops("read")).toHaveLength(0);
    delete process.env.ON_ACCOUNT_SERVICE_ENABLED;
    // the worker then does the Shopify part
    await runOnAccountWorker({ limit: 200 });
    expect((await rowOf(o.id)).state).toBe("WAITING_FOR_DELIVERY");
  });

  it("worker polls WAITING orders for the pickup audit event and applies it once", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    const source = vi.fn(async (gid: string) => (gid === o.id ? [{ id: "audit:77", occurredAt: "2026-10-20T10:00:00+00:00" }] : []));
    await runOnAccountWorker({ limit: 200, pickupEvents: source });
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ state: "INVOICE_SENT", triggerSource: "PICKUP_HANDOVER", triggerEventId: "offerteapp:audit:77" });
    await prisma.onAccountOrder.update({ where: { id: row.id }, data: { nextAttemptAt: null } });
    await runOnAccountWorker({ limit: 200, pickupEvents: source });
    expect(ops("invoice")).toHaveLength(1);
  });

  it("source unavailable (OfferteApp down) -> nothing happens, retried next pass", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    const rowId = (await rowOf(o.id)).id;
    const result = await runOnAccountWorker({ limit: 200, pickupEvents: async () => null });
    expect(result.polled.find((p) => p.id === rowId)?.outcome).toBe("SOURCE_UNAVAILABLE");
    expect((await rowOf(o.id)).state).toBe("WAITING_FOR_DELIVERY");
    expect((await rowOf(o.id)).nextAttemptAt).not.toBeNull();
  });
});

describe("CRM 'Afgeleverd bij klant' (bezorging v1)", () => {
  it("records once (double click = duplicate), validates the moment, then terms + one invoice", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    const row = await rowOf(o.id);
    await expect(recordManualDelivery(row.id, new Date(Date.now() + 3_600_000), "u1")).rejects.toThrow(/toekomst/);
    await expect(recordManualDelivery(row.id, new Date(row.createdAt.getTime() - 3 * 86_400_000), "u1")).rejects.toThrow(/vóór/);
    const at = new Date(Date.now() - 3_600_000);
    const [a, b] = await Promise.all([recordManualDelivery(row.id, at, "u1"), recordManualDelivery(row.id, at, "u1")]);
    expect([a.outcome, b.outcome].sort()).toEqual(["APPLIED", "DUPLICATE"]);
    const after = await rowOf(o.id);
    expect(after).toMatchObject({ state: "INVOICE_SENT", triggerSource: "MANUAL_DELIVERY", deliveredByUserId: "u1" });
    expect(ops("invoice")).toHaveLength(1);
  });
});

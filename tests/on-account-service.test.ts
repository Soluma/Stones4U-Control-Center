import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";

// Op rekening v1 — central service against the real test database and an
// in-memory FAKE Shopify that behaves like stones4u-dev did in fase 0:
// paymentTermsCreate REPLACES existing terms, a second delete says "Could not
// find payment terms", orderInvoiceSend mails again on every call and adds a
// "sent invoice" event, draft metafields do not exist on the order unless set.

type FakeOrder = {
  /** Phase I: quantities changed after the sale (refund/edit). */
  changed?: boolean;
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
  /** Phase I: what the fake OfferteApp knows per sendKey (it mails at most once per key). */
  mailKeys: new Map<string, "SENT" | "NOT_SENT" | "UNCERTAIN">(),
  /** Phase I: one-shot mail behaviours. */
  mailMode: null as null | "lostResponse" | "neverArrived" | "notSent" | "uncertain" | "rejected",
  objects: new Map<string, Buffer>(),
  noPaymentUrl: false,
  foreignPaymentUrl: false,
  company: null as null | Record<string, unknown>,
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
  setOrderInvoiceSentAt: vi.fn(async (gid: string, at: Date) => {
    shop.calls.push({ op: "marker", args: gid });
    maybeFail("marker");
    shop.orders.get(gid)!.metafields.invoiceSentAt = at.toISOString();
  }),
}));

const FULL_COMPANY = {
  name: "Stones4U",
  address: "Voorbeeldstraat 1",
  postcode: "4000 AA",
  city: "Tiel",
  phone: null,
  email: "info@stones4u.eu",
  website: "www.stones4u.eu",
  kvk: "12345678",
  vatNumber: "NL001234567B01",
  iban: "NL91ABNA0417164300",
  logo: null,
};

function invoiceOrderOf(o: FakeOrder) {
  const m = (amount: string) => ({ shopMoney: { amount } });
  const totalCents = Math.round(Number(o.total) * 100);
  const taxCents = Math.round((totalCents * 21) / 121);
  const tax = (taxCents / 100).toFixed(2);
  const taxLine = { title: "NL btw", rate: 0.21, ratePercentage: 21, priceSet: m(tax) };
  return {
    id: o.id,
    name: o.name,
    legacyResourceId: o.id.split("/").pop()!,
    createdAt: "2026-10-20T08:00:00Z",
    cancelledAt: o.cancelledAt,
    displayFinancialStatus: o.financial,
    currencyCode: "EUR",
    taxesIncluded: true,
    email: o.email,
    billingAddress: null,
    shippingAddress: null,
    customer: {
      displayName: "Jan Klant",
      email: o.email,
      defaultAddress: { company: "Klant B.V.", name: "Jan Klant", firstName: "Jan", lastName: "Klant", address1: "Teststraat 1", address2: null, zip: "1234 AB", city: "Tiel", country: "Netherlands", countryCodeV2: "NL" },
      vatNumber: null,
    },
    purchasingEntity: { __typename: "Customer" },
    lineItems: {
      nodes: [
        {
          id: `${o.id}/line`,
          title: "Testregel",
          variantTitle: null,
          sku: "T1",
          quantity: 1,
          currentQuantity: o.changed ? 0 : 1,
          originalUnitPriceSet: m(o.total),
          originalTotalSet: m(o.total),
          discountAllocations: [],
          taxLines: [taxLine],
        },
      ],
    },
    shippingLines: { nodes: [] },
    subtotalPriceSet: m(o.total),
    currentSubtotalPriceSet: m(o.total),
    totalDiscountsSet: m("0.00"),
    totalShippingPriceSet: m("0.00"),
    totalTaxSet: m(tax),
    currentTotalTaxSet: m(tax),
    totalPriceSet: m(o.total),
    currentTotalPriceSet: m(o.total),
    totalOutstandingSet: m(o.outstanding),
    taxLines: [taxLine],
    paymentTerms: o.terms ? { paymentTermsType: o.terms.type, paymentSchedules: { nodes: o.terms.dueAt ? [{ dueAt: o.terms.dueAt }] : [] } } : null,
  };
}

vi.mock("@/integrations/shopify/invoice-read", () => ({
  readInvoiceOrder: vi.fn(async (gid: string) => {
    await latency();
    shop.calls.push({ op: "invoiceRead", args: gid });
    maybeFail("invoiceRead");
    const o = shop.orders.get(gid);
    return o ? invoiceOrderOf(o) : null;
  }),
  readPaymentLink: vi.fn(async (gid: string) => {
    shop.calls.push({ op: "paymentLink", args: gid });
    maybeFail("paymentLink");
    const o = shop.orders.get(gid);
    if (!o) return null;
    const legacy = shop.foreignPaymentUrl ? "999" : gid.split("/").pop();
    return {
      displayFinancialStatus: o.financial,
      cancelledAt: o.cancelledAt,
      outstanding: o.outstanding,
      url: shop.noPaymentUrl ? null : `https://stones4u-dev.myshopify.com/98120958297/order_payment/${legacy}?secret=fake`,
    };
  }),
}));

vi.mock("@/integrations/offerteapp/invoice-mail", () => ({
  fetchCompanyProfile: vi.fn(async () => {
    maybeFail("company");
    return shop.company ?? FULL_COMPANY;
  }),
  sendInvoiceMail: vi.fn(async (req: { sendKey: string; to: string; subject: string; text: string; attachment: { filename: string; sha256: string; contentBase64: string } }) => {
    await latency();
    const known = shop.mailKeys.get(req.sendKey);
    if (known === "SENT") return { status: "SENT", messageId: `<${req.sendKey}@test>` }; // per-key dedupe: no second mail
    if (known === "UNCERTAIN") return { status: "UNCERTAIN", detail: "earlier hand-over uncertain" };
    const mode = shop.mailMode;
    shop.mailMode = null;
    if (mode === "neverArrived") return { status: "UNKNOWN", detail: "timeout (fake)" };
    if (mode === "notSent") {
      shop.mailKeys.set(req.sendKey, "NOT_SENT");
      return { status: "NOT_SENT", detail: "connect (fake)" };
    }
    if (mode === "uncertain") {
      shop.mailKeys.set(req.sendKey, "UNCERTAIN");
      return { status: "UNCERTAIN", detail: "disconnect mid-data (fake)" };
    }
    if (mode === "rejected") return { status: "REJECTED", detail: "HTTP 400 (fake)" };
    const { prisma: db } = await import("@/platform/db/prisma");
    const invoice = await db.onAccountInvoice.findUnique({ where: { sendKey: req.sendKey } });
    shop.calls.push({
      op: "invoice",
      args: { gid: invoice?.shopifyOrderGid, to: req.to, message: req.text, subject: req.subject, filename: req.attachment.filename, sha256: req.attachment.sha256, sendKey: req.sendKey, pdf: Buffer.from(req.attachment.contentBase64, "base64") },
    });
    shop.mailKeys.set(req.sendKey, "SENT");
    if (mode === "lostResponse") return { status: "UNKNOWN", detail: "response lost (fake)" }; // it DID go out
    return { status: "SENT", messageId: `<${req.sendKey}@test>` };
  }),
  invoiceMailStatus: vi.fn(async (key: string) => {
    const known = shop.mailKeys.get(key);
    if (known === "SENT") return { status: "SENT", messageId: `<${key}@test>` };
    if (known) return { status: known, detail: null };
    return { status: "NONE", detail: null };
  }),
}));

vi.mock("@/integrations/storage/r2", () => ({
  uploadObject: vi.fn(async (input: { storageKey: string; body: Buffer }) => {
    shop.calls.push({ op: "upload", args: input.storageKey });
    maybeFail("upload");
    shop.objects.set(input.storageKey, input.body);
  }),
  downloadObject: vi.fn(async (key: string) => {
    const body = shop.objects.get(key);
    if (!body) throw new Error("no such object (fake)");
    return body;
  }),
}));

process.env.ON_ACCOUNT_PAYMENT_LINK_HOSTS = "stones4u-dev.myshopify.com";

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
import { runScheduledOnAccountPass } from "@/modules/on-account/scheduler";

const created: string[] = [];
function newOrder(overrides: Partial<FakeOrder> = {}): FakeOrder {
  const n = Math.floor(Math.random() * 1e12);
  const o: FakeOrder = {
    id: `gid://shopify/Order/${n}`,
    name: `#T${n}`,
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
  shop.mailMode = null;
  shop.noPaymentUrl = false;
  shop.foreignPaymentUrl = false;
  shop.company = null;
});
afterAll(async () => {
  await prisma.onAccountInvoice.deleteMany({ where: { shopifyOrderGid: { in: created } } });
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

  it("mail response lost but OfferteApp recorded the send for this key -> INVOICE_SENT, no second mail", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.mailMode = "lostResponse";
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m4", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null });
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    expect(ops("invoice")).toHaveLength(1);
  });

  it("request never reached OfferteApp (timeout) -> back to INVOICE_READY with backoff; the next pass mails exactly once", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.mailMode = "neverArrived";
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m5", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null });
    const row = await rowOf(o.id);
    expect(row.state).toBe("INVOICE_READY");
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(ops("invoice")).toHaveLength(0);
    await prisma.onAccountOrder.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await reconcileOnAccountOrder(row.id);
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    expect(ops("invoice")).toHaveLength(1);
  });

  it("SMTP hand-over uncertain -> MANUAL_REVIEW INVOICE_SEND_UNCERTAIN; never re-sent automatically; a human 'not sent' allows exactly one more", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.mailMode = "uncertain";
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m5b", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null });
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "INVOICE_SEND_UNCERTAIN" });
    await runOnAccountWorker({ limit: 500 });
    await reconcileOnAccountOrder(row.id);
    expect(ops("invoice")).toHaveLength(0);
    const invoiceBefore = await prisma.onAccountInvoice.findUniqueOrThrow({ where: { onAccountOrderId: row.id } });
    const user = await prisma.user.create({ data: { email: `oa-${Date.now()}@example.com`, name: "T", passwordHash: "x", role: "ADMIN" } });
    await resolveReview(row.id, "RETRY_INVOICE", user.id, "Gecontroleerd: niet verstuurd");
    expect(ops("invoice")).toHaveLength(1);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    const invoiceAfter = await prisma.onAccountInvoice.findUniqueOrThrow({ where: { onAccountOrderId: row.id } });
    // the same invoice (number, snapshot, PDF), only a new send key
    expect(invoiceAfter.invoiceNumber).toBe(invoiceBefore.invoiceNumber);
    expect(invoiceAfter.pdfSha256).toBe(invoiceBefore.pdfSha256);
    expect(invoiceAfter.sendKey).not.toBe(invoiceBefore.sendKey);
    await prisma.auditEvent.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("paid between the invoice and the mail -> no payment mail, PAID, the invoice is kept (PAID_BEFORE_SEND)", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.mailMode = "notSent";
    await recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: "m6", kind: "MANUAL_DELIVERY", occurredAt: new Date(), actorUserId: null });
    const row = await rowOf(o.id);
    expect(row.state).toBe("INVOICE_READY");
    o.financial = "PAID";
    o.outstanding = "0.00";
    await prisma.onAccountOrder.update({ where: { id: row.id }, data: { nextAttemptAt: null } });
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("PAID");
    expect(ops("invoice")).toHaveLength(0);
    expect(await prisma.onAccountInvoice.findUniqueOrThrow({ where: { onAccountOrderId: row.id } })).toMatchObject({ mailSuppressedReason: "PAID_BEFORE_SEND", sentAt: null });
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

describe("scheduled pass (scheduler -> same idempotent worker)", () => {
  const readsOf = (gid: string) => ops("read").filter((c) => c.args === gid).length;

  it("two overlapping passes: exactly one runs, the other is SKIPPED_LOCKED; one invoice", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    let slowFirst = true;
    const source = async (gid: string) => {
      if (gid !== o.id) return [];
      if (slowFirst) {
        slowFirst = false;
        await new Promise((r) => setTimeout(r, 400)); // holds the lock
      }
      return [{ id: `pickup-${o.id}`, occurredAt: new Date(Date.now() - 60_000).toISOString() }];
    };
    const first = runScheduledOnAccountPass({ trigger: "test-a", pickupEvents: source, limit: 500 });
    await new Promise((r) => setTimeout(r, 100));
    const second = await runScheduledOnAccountPass({ trigger: "test-b", pickupEvents: source, limit: 500 });
    expect(second.status).toBe("SKIPPED_LOCKED");
    expect((await first).status).toBe("RAN");
    expect(await rowOf(o.id)).toMatchObject({ state: "INVOICE_SENT", triggerSource: "PICKUP_HANDOVER" });
    expect(ops("invoice").filter((c) => (c.args as { gid: string }).gid === o.id)).toHaveLength(1);
    // the lock is released after the pass
    expect((await runScheduledOnAccountPass({ trigger: "test-c", limit: 500 })).status).toBe("RAN");
  });

  it("an empty pass runs and changes nothing", async () => {
    await runScheduledOnAccountPass({ trigger: "warm", limit: 500 });
    shop.calls = [];
    const result = await runScheduledOnAccountPass({ trigger: "empty", limit: 500 });
    expect(result).toMatchObject({ status: "RAN", advanced: 0, polled: 0, stoppedByDeadline: false });
    expect(ops("invoice")).toHaveLength(0);
    expect(ops("create")).toHaveLength(0);
  });

  it("a retryable Shopify failure backs off (attempts, nextAttemptAt, lastError) and resumes later", async () => {
    const o = newOrder();
    const row = await prisma.onAccountOrder.create({ data: { shopifyOrderGid: o.id, sourceApp: "UNKNOWN", state: "REGISTERED" } });
    shop.fail.read = 1;
    await runScheduledOnAccountPass({ trigger: "retry-1", limit: 500 });
    const failed = await rowOf(o.id);
    expect(failed).toMatchObject({ state: "REGISTERED", attempts: 1 });
    expect(failed.lastError).toMatch(/read failed/);
    expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    const readsBefore = readsOf(o.id);
    await runScheduledOnAccountPass({ trigger: "retry-2", limit: 500 });
    expect(readsOf(o.id)).toBe(readsBefore); // still backing off: not touched
    await prisma.onAccountOrder.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await runScheduledOnAccountPass({ trigger: "retry-3", limit: 500 });
    expect((await rowOf(o.id)).state).toBe("WAITING_FOR_DELIVERY");
  });

  it("MANUAL_REVIEW is never picked up again, however many passes run", async () => {
    const o = newOrder();
    await prisma.onAccountOrder.create({ data: { shopifyOrderGid: o.id, sourceApp: "UNKNOWN", state: "MANUAL_REVIEW", reviewReason: "INVOICE_SEND_UNCERTAIN" } });
    for (let i = 0; i < 3; i++) await runScheduledOnAccountPass({ trigger: `review-${i}`, limit: 500, pickupEvents: async () => [] });
    expect(readsOf(o.id)).toBe(0);
    expect(await rowOf(o.id)).toMatchObject({ state: "MANUAL_REVIEW", attempts: 0 });
  });

  it("past the deadline no new order is started", async () => {
    const o = newOrder();
    await prisma.onAccountOrder.create({ data: { shopifyOrderGid: o.id, sourceApp: "UNKNOWN", state: "REGISTERED" } });
    const result = await runScheduledOnAccountPass({ trigger: "deadline", limit: 500, deadlineMs: 0 });
    expect(result).toMatchObject({ status: "RAN", advanced: 0, stoppedByDeadline: true });
    expect(readsOf(o.id)).toBe(0);
  });
});

describe("E2E fault injection (staging-only switches)", () => {
  const DEV = "stones4u-dev.myshopify.com";
  const setEnv = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const clear = () =>
    setEnv({ E2E_ON_ACCOUNT_FAULT: undefined, E2E_ON_ACCOUNT_FAULT_ORDER: undefined, SHOPIFY_SHOP_DOMAIN: undefined, SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: undefined });

  it("is inert unless point, exact order and dev-only shop wiring all match", async () => {
    const { e2eFaultActive } = await import("@/modules/on-account/e2e-fault");
    const gid = "gid://shopify/Order/1";
    setEnv({ E2E_ON_ACCOUNT_FAULT: "crash_after_invoice_send", E2E_ON_ACCOUNT_FAULT_ORDER: gid, SHOPIFY_SHOP_DOMAIN: DEV, SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: DEV });
    expect(e2eFaultActive("crash_after_invoice_send", gid)).toBe(true);
    expect(e2eFaultActive("crash_after_invoice_send", "gid://shopify/Order/2")).toBe(false);
    expect(e2eFaultActive("invoice_send_outcome_unknown", gid)).toBe(false);
    setEnv({ SHOPIFY_SHOP_DOMAIN: "9h7x2c-ku.myshopify.com" });
    expect(e2eFaultActive("crash_after_invoice_send", gid)).toBe(false);
    setEnv({ SHOPIFY_SHOP_DOMAIN: DEV, SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: `${DEV},9h7x2c-ku.myshopify.com` });
    expect(e2eFaultActive("crash_after_invoice_send", gid)).toBe(false);
    clear();
    expect(e2eFaultActive("crash_after_invoice_send", gid)).toBe(false);
  });

  it("crash after a real send: stays INVOICE_SENDING, then adopts OfferteApp's record of the key — never a second mail", async () => {
    const o = newOrder({ metafields: { termDays: "30", handedOverAt: new Date(Date.now() - 60_000).toISOString(), invoiceSentAt: null } });
    setEnv({ E2E_ON_ACCOUNT_FAULT: "crash_after_invoice_send", E2E_ON_ACCOUNT_FAULT_ORDER: o.id, SHOPIFY_SHOP_DOMAIN: DEV, SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: DEV });
    await registerOnAccountOrder(o.id, "WEBHOOK");
    clear();
    const stuck = await rowOf(o.id);
    expect(stuck.state).toBe("INVOICE_SENDING");
    expect(ops("invoice")).toHaveLength(1);
    await prisma.onAccountOrder.update({ where: { id: stuck.id }, data: { invoiceSendingAt: new Date(Date.now() - 5 * 60_000), nextAttemptAt: null } });
    const final = await reconcileOnAccountOrder(stuck.id);
    expect(final.state).toBe("INVOICE_SENT");
    expect(ops("invoice")).toHaveLength(1);
  });

  it("SMTP outcome uncertain (fault switch): MANUAL_REVIEW, no automatic resend", async () => {
    const o = newOrder({ metafields: { termDays: "30", handedOverAt: new Date(Date.now() - 60_000).toISOString(), invoiceSentAt: null } });
    setEnv({ E2E_ON_ACCOUNT_FAULT: "invoice_mail_uncertain", E2E_ON_ACCOUNT_FAULT_ORDER: o.id, SHOPIFY_SHOP_DOMAIN: DEV, SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS: DEV });
    await registerOnAccountOrder(o.id, "WEBHOOK");
    clear();
    expect(await rowOf(o.id)).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "INVOICE_SEND_UNCERTAIN" });
    await runOnAccountWorker({ limit: 500 });
    expect(ops("invoice")).toHaveLength(0);
  });
});

describe("Phase I — the ONE definitive invoice + ONE Stones4U invoice mail", () => {
  const DEV = "stones4u-dev.myshopify.com";
  const invoiceOf = (rowId: string) => prisma.onAccountInvoice.findUnique({ where: { onAccountOrderId: rowId } });
  const deliver = (o: FakeOrder, key: string) =>
    recordDelivery({ orderGid: o.id, triggerSource: "MANUAL_DELIVERY", source: "crm", eventKey: key, kind: "MANUAL_DELIVERY", occurredAt: new Date(Date.now() - 60_000), actorUserId: null });
  const due = async (rowId: string) => prisma.onAccountOrder.update({ where: { id: rowId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  const withFault = (point: string, gid: string) => {
    process.env.E2E_ON_ACCOUNT_FAULT = point;
    process.env.E2E_ON_ACCOUNT_FAULT_ORDER = gid;
    process.env.SHOPIFY_SHOP_DOMAIN = DEV;
    process.env.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS = DEV;
  };
  const noFault = () => {
    for (const k of ["E2E_ON_ACCOUNT_FAULT", "E2E_ON_ACCOUNT_FAULT_ORDER", "SHOPIFY_SHOP_DOMAIN", "SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS"]) delete process.env[k];
  };
  const termsSetRow = (o: FakeOrder, termsId: string, extra: Record<string, unknown> = {}) =>
    prisma.onAccountOrder.create({
      data: {
        shopifyOrderGid: o.id,
        sourceApp: "SOURCE2POS",
        termDays: 30,
        state: "TERMS_SET",
        deliveredAt: new Date("2026-10-20T10:00:00Z"),
        triggerSource: "MANUAL_DELIVERY",
        dueAt: new Date("2026-11-19T22:59:59Z"),
        paymentTermsId: termsId,
        termsSetAt: new Date(),
        ...extra,
      },
    });

  it("invoice number = Shopify order number; amounts are Shopify's; the stored PDF is exactly the attached one", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    await deliver(o, "i1");
    const row = await rowOf(o.id);
    expect(row.state).toBe("INVOICE_SENT");
    const inv = (await invoiceOf(row.id))!;
    expect(inv.invoiceNumber).toBe(o.name.replace("#", ""));
    expect(inv.shopifyOrderGid).toBe(o.id);
    expect(inv.totalAmount.toFixed(2)).toBe("48.40");
    expect(inv.taxAmount.toFixed(2)).toBe("8.40");
    expect(inv.outstandingAmount.toFixed(2)).toBe("48.40");
    expect(inv.dueAt.toISOString()).toBe(row.dueAt!.toISOString());
    expect(inv.deliveredAt.toISOString()).toBe(row.deliveredAt!.toISOString());
    expect(inv.storageKey).toBe(`invoices/${inv.invoiceDate.slice(0, 4)}/${inv.invoiceNumber}/${inv.pdfSha256}.pdf`);
    const stored = shop.objects.get(inv.storageKey)!;
    expect(stored.subarray(0, 5).toString()).toBe("%PDF-");
    expect(createHash("sha256").update(stored).digest("hex")).toBe(inv.pdfSha256);
    const mail = ops("invoice")[0]!.args as { subject: string; filename: string; sha256: string; pdf: Buffer; message: string };
    expect(mail.subject).toBe(`Factuur Stones4U ${inv.invoiceNumber}`);
    expect(mail.filename).toBe(`Factuur_${inv.invoiceNumber}.pdf`);
    expect(mail.sha256).toBe(inv.pdfSha256);
    expect(mail.pdf.equals(stored)).toBe(true);
    expect(mail.message).toContain(`Factuurnummer: ${inv.invoiceNumber}`);
    expect(mail.message).toContain("Te betalen: € 48,40");
    expect(mail.message).toContain("order_payment/");
    expect(inv).toMatchObject({ mailRecipient: "klant@example.com", sentAt: expect.any(Date), mailSuppressedReason: null });
    const snapshot = inv.snapshot as { lines: { netExclCents: number; vatCents: number }[]; totals: { totalCents: number } };
    expect(snapshot.totals.totalCents).toBe(4840);
    expect(snapshot.lines[0]).toMatchObject({ netExclCents: 4000, vatCents: 840 });
  });

  it("three workers at TERMS_SET: exactly one invoice, one PDF upload, one mail", async () => {
    const o = newOrder({ terms: { id: "gid://shopify/PaymentTerms/ours2", type: "FIXED", dueAt: "2026-11-19T22:59:59Z" } });
    const row = await termsSetRow(o, "gid://shopify/PaymentTerms/ours2");
    await Promise.all([reconcileOnAccountOrder(row.id), reconcileOnAccountOrder(row.id), reconcileOnAccountOrder(row.id)]);
    expect(ops("upload")).toHaveLength(1);
    expect(await prisma.onAccountInvoice.count({ where: { shopifyOrderGid: o.id } })).toBe(1);
    expect(ops("invoice")).toHaveLength(1);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
  });

  it("scheduler again / later reconciles never rebuild the invoice nor mail again", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    await deliver(o, "i3");
    const row = await rowOf(o.id);
    const before = (await invoiceOf(row.id))!;
    await reconcileOnAccountOrder(row.id);
    await runOnAccountWorker({ limit: 500 });
    await runScheduledOnAccountPass({ trigger: "phase-i", limit: 500 });
    const after = (await invoiceOf(row.id))!;
    expect(after.snapshotSha256).toBe(before.snapshotSha256);
    expect(after.pdfSha256).toBe(before.pdfSha256);
    expect(ops("upload").filter((c) => String(c.args).includes(`/${before.invoiceNumber}/`))).toHaveLength(1);
    expect(ops("invoice").filter((c) => (c.args as { gid: string }).gid === o.id)).toHaveLength(1);
  });

  it("PDF generation fails -> nothing stored, nothing sent, TERMS_SET with backoff; next attempt makes exactly one invoice", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    withFault("invoice_pdf_render_fails", o.id);
    await deliver(o, "i4");
    noFault();
    const row = await rowOf(o.id);
    expect(row.state).toBe("TERMS_SET");
    expect(row.lastError).toMatch(/invoice_pdf_render_fails/);
    expect(await invoiceOf(row.id)).toBeNull();
    expect(ops("invoice")).toHaveLength(0);
    await due(row.id);
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    expect(ops("invoice")).toHaveLength(1);
  });

  it("Shopify gives no payment URL -> no mail, INVOICE_READY with backoff; once it does -> exactly one mail", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.noPaymentUrl = true;
    await deliver(o, "i5");
    const row = await rowOf(o.id);
    expect(row.state).toBe("INVOICE_READY");
    expect(row.lastError).toMatch(/PAYMENT_LINK_UNAVAILABLE/);
    expect(ops("invoice")).toHaveLength(0);
    shop.noPaymentUrl = false;
    await due(row.id);
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    expect(ops("invoice")).toHaveLength(1);
  });

  it("a payment URL for another order is never mailed (MANUAL_REVIEW)", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.foreignPaymentUrl = true;
    await deliver(o, "i6");
    expect(await rowOf(o.id)).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "PAYMENT_LINK_UNAVAILABLE" });
    expect(ops("invoice")).toHaveLength(0);
  });

  it("mail definitely not sent (SMTP refused) -> back to INVOICE_READY; retry with the same key mails exactly once", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.mailMode = "notSent";
    await deliver(o, "i7");
    const row = await rowOf(o.id);
    expect(row.state).toBe("INVOICE_READY");
    const key = (await invoiceOf(row.id))!.sendKey;
    await due(row.id);
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    expect(ops("invoice")).toHaveLength(1);
    expect((ops("invoice")[0]!.args as { sendKey: string }).sendKey).toBe(key);
  });

  it("mail provider rejects the request -> MANUAL_REVIEW, nothing sent", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.mailMode = "rejected";
    await deliver(o, "i7b");
    expect(await rowOf(o.id)).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "INVOICE_MAIL_REJECTED" });
    expect(ops("invoice")).toHaveLength(0);
  });

  it("cancelled after the invoice, before the mail -> CANCELLED, no mail", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.mailMode = "notSent";
    await deliver(o, "i8");
    const row = await rowOf(o.id);
    o.cancelledAt = new Date().toISOString();
    await due(row.id);
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("CANCELLED");
    expect(ops("invoice")).toHaveLength(0);
    expect((await invoiceOf(row.id))!.mailSuppressedReason).toBe("CANCELLED_BEFORE_SEND");
  });

  it("paid before the invoice is built -> the invoice is still made (bookkeeping), no mail, PAID", async () => {
    const o = newOrder({ terms: { id: "gid://shopify/PaymentTerms/ours3", type: "FIXED", dueAt: "2026-11-19T22:59:59Z" } });
    o.financial = "PAID";
    o.outstanding = "0.00";
    const row = await termsSetRow(o, "gid://shopify/PaymentTerms/ours3");
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("PAID");
    expect(ops("invoice")).toHaveLength(0);
    expect(await invoiceOf(row.id)).toMatchObject({ mailSuppressedReason: "PAID_BEFORE_SEND", sentAt: null });
  });

  it("order changed after the sale (quantity refunded) -> MANUAL_REVIEW, no invoice", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    o.changed = true;
    await deliver(o, "i9");
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "INVOICE_ORDER_CHANGED" });
    expect(await invoiceOf(row.id)).toBeNull();
    expect(ops("invoice")).toHaveLength(0);
  });

  it("Stones4U company details incomplete (e.g. no IBAN) -> MANUAL_REVIEW, no invoice", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.company = { ...FULL_COMPANY, iban: null };
    await deliver(o, "i10");
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "COMPANY_PROFILE_INCOMPLETE" });
    expect(row.lastError).toContain("iban");
    expect(await invoiceOf(row.id)).toBeNull();
  });

  it("OfferteApp unreachable for the company details -> TERMS_SET with backoff (fails gracefully)", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.fail.company = 1;
    await deliver(o, "i11");
    const row = await rowOf(o.id);
    expect(row.state).toBe("TERMS_SET");
    expect(row.attempts).toBe(1);
    expect(await invoiceOf(row.id)).toBeNull();
  });

  it("a stored PDF that no longer matches its checksum is never mailed", async () => {
    const o = newOrder();
    await registerOnAccountOrder(o.id, "WEBHOOK");
    shop.mailMode = "notSent";
    await deliver(o, "i12");
    const row = await rowOf(o.id);
    const inv = (await invoiceOf(row.id))!;
    shop.objects.set(inv.storageKey, Buffer.from("%PDF-tampered"));
    await due(row.id);
    await reconcileOnAccountOrder(row.id);
    expect(await rowOf(o.id)).toMatchObject({ state: "MANUAL_REVIEW", reviewReason: "INVOICE_PDF_INTEGRITY" });
    expect(ops("invoice")).toHaveLength(0);
  });

  it("a crashed generator (INVOICE_GENERATING past the grace) is retried safely", async () => {
    const o = newOrder({ terms: { id: "gid://shopify/PaymentTerms/ours4", type: "FIXED", dueAt: "2026-11-19T22:59:59Z" } });
    const row = await termsSetRow(o, "gid://shopify/PaymentTerms/ours4", { state: "INVOICE_GENERATING", invoiceGeneratingAt: new Date(Date.now() - 10 * 60_000) });
    await reconcileOnAccountOrder(row.id);
    expect((await rowOf(o.id)).state).toBe("INVOICE_SENT");
    expect(ops("invoice")).toHaveLength(1);
  });
});

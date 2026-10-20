import "server-only";
import { Prisma, type OnAccountOrder, type OnAccountState, type OnAccountTriggerSource } from "@/generated/prisma";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { readOnAccountOrder, type OnAccountOrderSnapshot } from "@/integrations/shopify/on-account-read";
import {
  createFixedPaymentTerms,
  deleteOrderPaymentTerms,
  sendOrderInvoice,
  setOrderInvoiceSentAt,
  updateToFixedPaymentTerms,
} from "@/integrations/shopify/on-account";
import { computeDueAt, InvalidTermDaysError, invoiceMessage, ON_ACCOUNT_TAG, parseTermDays, sameInstant } from "./rules";
import {
  assertTransition,
  MAX_ATTEMPTS,
  nextAttemptDelayMs,
  REVIEW_REASON_LABELS,
  TERMINAL_STATES,
  type ReviewReason,
} from "./state-machine";

// Op rekening v1 — the ONE place where payment-due logic runs
// (docs/ON-ACCOUNT-PAYMENT-DUE.md). POS, OfferteApp, Pick App and transport
// only report facts (order created on account, goods handed over); this
// service decides and performs every payment-terms / invoice action.
//
// Rules that make it safe to run twice, concurrently, or after a crash:
// - Every step first READS the exact Shopify order and only writes when the
//   live state differs from the target (Shopify itself is not idempotent).
// - Every local state change is a compare-and-set on the expected current
//   state (updateMany where state = expected), so only one caller wins.
// - deliveredAt is written once (where deliveredAt IS NULL); later delivery
//   events are stored and ignored.
// - The invoice is claimed (TERMS_SET -> INVOICE_SENDING) before sending. If
//   the outcome is unknown (timeout/crash) it is only ever resolved from a
//   Shopify-side marker or "sent invoice" event — never by mailing again.

export type SourceApp = "SOURCE2POS" | "OFFERTEAPP" | "UNKNOWN";

export function detectSourceApp(appName: string | null): SourceApp {
  const name = (appName ?? "").toLowerCase();
  if (name.includes("source2pos")) return "SOURCE2POS";
  if (name.includes("offerteapp")) return "OFFERTEAPP";
  return "UNKNOWN";
}

/** An invoice send whose outcome is unknown may still be in flight this long. */
const IN_FLIGHT_SEND_GRACE_MS = 2 * 60_000;
/** WAITING_FOR_DELIVERY orders are polled for a pickup event this often. */
export const PICKUP_POLL_INTERVAL_MS = 15 * 60_000;
const MAX_STEPS_PER_RECONCILE = 8;

// ── small helpers ────────────────────────────────────────────────────

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

function amount(value: string): number {
  return Math.round(Number(value) * 100);
}

/** Compare-and-set: only moves the row if it is still in `from`. */
async function moveState(
  row: Pick<OnAccountOrder, "id" | "state">,
  to: OnAccountState,
  data: Prisma.OnAccountOrderUpdateManyMutationInput = {},
): Promise<boolean> {
  assertTransition(row.state, to);
  const result = await prisma.onAccountOrder.updateMany({
    where: { id: row.id, state: row.state },
    data: { ...data, state: to },
  });
  return result.count === 1;
}

async function toReview(row: OnAccountOrder, reason: ReviewReason, detail?: string): Promise<void> {
  if (row.state === "MANUAL_REVIEW") return;
  const moved = await moveState(row, "MANUAL_REVIEW", {
    reviewReason: reason,
    lastError: detail ? `${reason}: ${detail}`.slice(0, 300) : reason,
    nextAttemptAt: null,
  });
  if (moved) {
    await logAudit({
      userId: null,
      action: "on_account.manual_review",
      entityType: "OnAccountOrder",
      entityId: row.id,
      metadata: { orderGid: row.shopifyOrderGid, reason, label: REVIEW_REASON_LABELS[reason], detail: detail ?? null },
    });
  }
}

/** A failed attempt: backoff, and MANUAL_REVIEW once the attempts run out. */
async function recordFailure(stale: OnAccountOrder, error: unknown): Promise<void> {
  // Re-read: the step may have moved the row (e.g. REGISTERED -> PENDING_TEMP_TERMS) before failing.
  const row = (await prisma.onAccountOrder.findUnique({ where: { id: stale.id } })) ?? stale;
  if (TERMINAL_STATES.has(row.state) || row.state === "MANUAL_REVIEW") return;
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await prisma.onAccountOrder.update({ where: { id: row.id }, data: { attempts } });
    await toReview({ ...row, attempts }, "RETRIES_EXHAUSTED", shortError(error));
    return;
  }
  await prisma.onAccountOrder.updateMany({
    where: { id: row.id, state: row.state },
    data: { attempts, lastError: shortError(error), nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(attempts)) },
  });
}

/** Snapshot of the order's term: metafield (canonical) or the atomic custom attribute. */
export function resolveSnapshotTermDays(snapshot: OnAccountOrderSnapshot): { termDays: number } | { error: ReviewReason; detail: string } {
  try {
    const fromMetafield = parseTermDays(snapshot.metafields.termDays);
    const fromAttribute = parseTermDays(snapshot.attributes.termDays);
    if (fromMetafield !== null && fromAttribute !== null && fromMetafield !== fromAttribute) {
      return { error: "TERM_DAYS_INVALID", detail: `metafield ${fromMetafield} ≠ attribuut ${fromAttribute}` };
    }
    const termDays = fromMetafield ?? fromAttribute;
    if (termDays === null) return { error: "TERM_DAYS_MISSING", detail: "geen stones4u.payment_term_days op de order" };
    return { termDays };
  } catch (error) {
    if (error instanceof InvalidTermDaysError) return { error: "TERM_DAYS_INVALID", detail: error.message };
    throw error;
  }
}

/** Terminal/unpayable checks shared by every step. Returns true when the row was moved. */
async function settleIfNotPayable(row: OnAccountOrder, snapshot: OnAccountOrderSnapshot): Promise<boolean> {
  if (snapshot.cancelledAt) {
    return moveState(row, "CANCELLED", { cancelledAt: new Date(snapshot.cancelledAt), nextAttemptAt: null });
  }
  if (snapshot.displayFinancialStatus === "PAID" || amount(snapshot.outstanding) <= 0) {
    return moveState(row, "PAID", { paidAt: new Date(), nextAttemptAt: null });
  }
  if (!snapshot.tags.includes(ON_ACCOUNT_TAG)) {
    await toReview(row, "NOT_ON_ACCOUNT", "tag op-rekening ontbreekt");
    return true;
  }
  if (snapshot.displayFinancialStatus !== "PENDING") {
    await toReview(row, "NOT_PENDING", snapshot.displayFinancialStatus ?? "onbekend");
    return true;
  }
  return false;
}

function handedOverAt(snapshot: OnAccountOrderSnapshot): string | null {
  return snapshot.metafields.handedOverAt ?? snapshot.attributes.handedOverAt;
}

// ── registration ─────────────────────────────────────────────────────

export type RegisterResult =
  | { registered: true; id: string; state: OnAccountState }
  | { registered: false; reason: "ORDER_NOT_FOUND" | "NOT_ON_ACCOUNT" };

/**
 * Registers an order tagged op-rekening (orders/create webhook, or an admin)
 * and runs it as far as it can go. Safe to call any number of times.
 */
export async function registerOnAccountOrder(orderGid: string, via: "WEBHOOK" | "MANUAL" | "API" | "WORKER", actorUserId: string | null = null): Promise<RegisterResult> {
  const snapshot = await readOnAccountOrder(orderGid);
  if (!snapshot) return { registered: false, reason: "ORDER_NOT_FOUND" };
  if (!snapshot.tags.includes(ON_ACCOUNT_TAG)) return { registered: false, reason: "NOT_ON_ACCOUNT" };

  let row: OnAccountOrder;
  try {
    row = await prisma.onAccountOrder.create({
      data: { shopifyOrderGid: orderGid, orderName: snapshot.name, sourceApp: detectSourceApp(snapshot.appName), state: "REGISTERED" },
    });
    await logAudit({
      userId: actorUserId,
      action: "on_account.registered",
      entityType: "OnAccountOrder",
      entityId: row.id,
      metadata: { orderGid, orderName: snapshot.name, via, sourceApp: row.sourceApp },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    row = await prisma.onAccountOrder.findUniqueOrThrow({ where: { shopifyOrderGid: orderGid } });
  }

  const final = await reconcileOnAccountOrder(row.id, { snapshot });
  return { registered: true, id: row.id, state: final.state };
}

// ── the step machine ─────────────────────────────────────────────────

type StepOutcome = "MOVED" | "IDLE";

/** REGISTERED / PENDING_TEMP_TERMS: snapshot term, remove temporary terms, adopt a counter handover. */
async function stepCleanup(row: OnAccountOrder, snapshot: OnAccountOrderSnapshot): Promise<StepOutcome> {
  if (await settleIfNotPayable(row, snapshot)) return "MOVED";

  if (row.termDays === null) {
    const term = resolveSnapshotTermDays(snapshot);
    if ("error" in term) {
      await toReview(row, term.error, term.detail);
      return "MOVED";
    }
    await prisma.onAccountOrder.updateMany({ where: { id: row.id, state: row.state }, data: { termDays: term.termDays, orderName: snapshot.name, sourceApp: detectSourceApp(snapshot.appName) } });
    row = { ...row, termDays: term.termDays };
  }

  const terms = snapshot.paymentTerms;
  if (terms) {
    if (terms.type !== "FULFILLMENT") {
      // RECEIPT/NET/FIXED before any delivery: not something this flow puts there.
      await toReview(row, "UNEXPECTED_PAYMENT_TERMS", terms.type);
      return "MOVED";
    }
    if (row.state === "REGISTERED") {
      await moveState(row, "PENDING_TEMP_TERMS");
      row = { ...row, state: "PENDING_TEMP_TERMS" };
    }
    await deleteOrderPaymentTerms(terms.id); // DELETED or ALREADY_GONE — both fine
    const verify = await readOnAccountOrder(row.shopifyOrderGid);
    if (!verify) throw new Error("ORDER_NOT_FOUND na verwijderen tijdelijke termijn");
    if (verify.paymentTerms) throw new Error(`tijdelijke termijn staat er nog (${verify.paymentTerms.type})`);
    snapshot = verify;
  }

  const moved = await moveState(row, "WAITING_FOR_DELIVERY", { attempts: 0, lastError: null, nextAttemptAt: null });
  if (!moved) return "IDLE";

  const counter = handedOverAt(snapshot);
  if (counter) {
    await recordDelivery({
      orderGid: row.shopifyOrderGid,
      triggerSource: "COUNTER_HANDOVER",
      source: "source2pos",
      eventKey: `handed_over_at:${row.shopifyOrderGid}`,
      kind: "COUNTER_HANDOVER",
      occurredAt: new Date(counter),
      actorUserId: null,
      skipReconcile: true,
    });
  }
  return "MOVED";
}

/** DELIVERED: put FIXED terms with the exact dueAt on the order (read-compare-write-verify). */
async function stepTerms(row: OnAccountOrder, snapshot: OnAccountOrderSnapshot): Promise<StepOutcome> {
  if (await settleIfNotPayable(row, snapshot)) return "MOVED";
  if (!row.deliveredAt || row.termDays === null) {
    await toReview(row, row.termDays === null ? "TERM_DAYS_MISSING" : "DUE_DATE_CONFLICT", "geen leverdatum of termijn");
    return "MOVED";
  }
  const dueAt = computeDueAt(row.deliveredAt, row.termDays);
  const terms = snapshot.paymentTerms;
  const current = terms?.schedules[0]?.dueAt ?? null;

  if (terms && terms.type === "FIXED" && sameInstant(current, dueAt)) {
    // Already exactly right — NO-OP, no mutation "for safety".
  } else if (!terms) {
    await createFixedPaymentTerms(row.shopifyOrderGid, dueAt);
  } else if (terms.type === "FULFILLMENT" || (terms.type === "FIXED" && row.paymentTermsId === terms.id)) {
    // Temporary terms still there, or our own FIXED terms with an old dueAt.
    await updateToFixedPaymentTerms(terms.id, dueAt);
  } else if (terms.type === "FIXED") {
    await toReview(row, "DUE_DATE_CONFLICT", `andere vervaldatum ${current ?? "?"} op de order`);
    return "MOVED";
  } else {
    await toReview(row, "UNEXPECTED_PAYMENT_TERMS", terms.type);
    return "MOVED";
  }

  const verify = await readOnAccountOrder(row.shopifyOrderGid);
  const verified = verify?.paymentTerms;
  if (!verified || verified.type !== "FIXED" || !sameInstant(verified.schedules[0]?.dueAt ?? null, dueAt)) {
    throw new Error("vervaldatum niet bevestigd na schrijven");
  }
  const moved = await moveState(row, "TERMS_SET", {
    dueAt,
    paymentTermsId: verified.id,
    termsSetAt: new Date(),
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  if (moved) {
    await logAudit({
      userId: null,
      action: "on_account.terms_set",
      entityType: "OnAccountOrder",
      entityId: row.id,
      metadata: { orderGid: row.shopifyOrderGid, dueAt: dueAt.toISOString(), termDays: row.termDays, triggerSource: row.triggerSource },
    });
  }
  return moved ? "MOVED" : "IDLE";
}

async function markInvoiceSent(row: OnAccountOrder, sentAt: Date, recipient: string | null, how: string): Promise<void> {
  const moved = await moveState(row, "INVOICE_SENT", {
    invoiceSentAt: sentAt,
    invoiceRecipient: recipient ?? row.invoiceRecipient,
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  if (!moved) return;
  await logAudit({
    userId: null,
    action: "on_account.invoice_sent",
    entityType: "OnAccountOrder",
    entityId: row.id,
    metadata: { orderGid: row.shopifyOrderGid, sentAt: sentAt.toISOString(), how },
  });
  try {
    await setOrderInvoiceSentAt(row.shopifyOrderGid, sentAt);
  } catch (error) {
    // The mail went out and is recorded locally; the Shopify marker is the
    // second lock. Log, keep INVOICE_SENT — never mail again because of this.
    await prisma.onAccountOrder.update({ where: { id: row.id }, data: { lastError: `invoice_sent_at marker: ${shortError(error)}` } });
  }
}

/** Resolve an INVOICE_SENDING whose outcome is unknown — from Shopify only, never by resending. */
async function resolveUncertainSend(row: OnAccountOrder, snapshot: OnAccountOrderSnapshot): Promise<StepOutcome> {
  if (snapshot.metafields.invoiceSentAt) {
    await markInvoiceSent(row, new Date(snapshot.metafields.invoiceSentAt), null, "shopify_marker");
    return "MOVED";
  }
  const since = (row.invoiceSendingAt?.getTime() ?? 0) - 5_000;
  const event = snapshot.invoiceEvents.find((e) => new Date(e.createdAt).getTime() >= since);
  if (event) {
    await markInvoiceSent(row, new Date(event.createdAt), null, "shopify_event");
    return "MOVED";
  }
  if (snapshot.displayFinancialStatus === "PAID" || amount(snapshot.outstanding) <= 0) {
    await moveState(row, "PAID", { paidAt: new Date(), nextAttemptAt: null });
    return "MOVED";
  }
  await toReview(row, "INVOICE_SEND_UNCERTAIN", row.lastError ?? undefined);
  return "MOVED";
}

/** TERMS_SET: claim, send exactly one invoice, record it twice (DB + Shopify marker). */
async function stepInvoice(row: OnAccountOrder, snapshot: OnAccountOrderSnapshot): Promise<StepOutcome> {
  if (await settleIfNotPayable(row, snapshot)) return "MOVED";
  if (snapshot.metafields.invoiceSentAt) {
    // Second lock: Shopify already says it was sent.
    await markInvoiceSent(row, new Date(snapshot.metafields.invoiceSentAt), null, "shopify_marker");
    return "MOVED";
  }
  const terms = snapshot.paymentTerms;
  if (!terms || terms.type !== "FIXED" || !row.dueAt || !sameInstant(terms.schedules[0]?.dueAt ?? null, row.dueAt)) {
    await toReview(row, "DUE_DATE_CONFLICT", "vervaldatum op de order wijkt af van wat is gezet");
    return "MOVED";
  }
  const recipient = snapshot.email ?? snapshot.customerEmail;
  if (!recipient) {
    await toReview(row, "NO_INVOICE_RECIPIENT");
    return "MOVED";
  }

  // The claim: exactly one worker can move TERMS_SET -> INVOICE_SENDING.
  const sendingAt = new Date();
  const claimed = await moveState(row, "INVOICE_SENDING", { invoiceSendingAt: sendingAt, invoiceRecipient: recipient });
  if (!claimed) return "IDLE";
  const sending: OnAccountOrder = { ...row, state: "INVOICE_SENDING", invoiceSendingAt: sendingAt, invoiceRecipient: recipient };

  let result: Awaited<ReturnType<typeof sendOrderInvoice>>;
  try {
    result = await sendOrderInvoice(
      row.shopifyOrderGid,
      recipient,
      invoiceMessage({ termDays: row.termDays ?? 0, dueAt: row.dueAt, deliveredAt: row.deliveredAt ?? sendingAt, triggerSource: row.triggerSource ?? "" }),
    );
  } catch (error) {
    // Outcome unknown: stay INVOICE_SENDING, then try to resolve from Shopify.
    await prisma.onAccountOrder.update({ where: { id: row.id }, data: { lastError: `INVOICE_SEND_OUTCOME_UNKNOWN: ${shortError(error)}` } });
    const after = await readOnAccountOrder(row.shopifyOrderGid).catch(() => null);
    if (!after) {
      await toReview({ ...sending, lastError: shortError(error) }, "INVOICE_SEND_UNCERTAIN", shortError(error));
      return "MOVED";
    }
    return resolveUncertainSend({ ...sending, lastError: shortError(error) }, after);
  }

  if (result.outcome === "SENT") {
    await markInvoiceSent(sending, new Date(), recipient, "order_invoice_send");
    return "MOVED";
  }

  // Shopify definitely did not send (userErrors). Re-read: paid in between?
  const after = await readOnAccountOrder(row.shopifyOrderGid);
  if (after && (after.displayFinancialStatus === "PAID" || amount(after.outstanding) <= 0)) {
    await moveState(sending, "PAID", { paidAt: new Date(), nextAttemptAt: null });
    return "MOVED";
  }
  const message = result.userErrors.map((e) => e.message).join("; ");
  await moveState(sending, "TERMS_SET", { invoiceSendingAt: null });
  await recordFailure({ ...sending, state: "TERMS_SET" }, new Error(`orderInvoiceSend weigerde: ${message}`));
  return "IDLE";
}

/**
 * Advances one order as far as possible. Idempotent; safe to call from the
 * webhook, the worker and the UI at the same time.
 */
export async function reconcileOnAccountOrder(id: string, options: { snapshot?: OnAccountOrderSnapshot } = {}): Promise<OnAccountOrder> {
  let snapshot = options.snapshot ?? null;
  for (let step = 0; step < MAX_STEPS_PER_RECONCILE; step++) {
    const row = await prisma.onAccountOrder.findUniqueOrThrow({ where: { id } });
    if (TERMINAL_STATES.has(row.state) || row.state === "MANUAL_REVIEW") return row;
    try {
      snapshot = snapshot ?? (await readOnAccountOrder(row.shopifyOrderGid));
      if (!snapshot) {
        await recordFailure(row, new Error("ORDER_NOT_FOUND"));
        return prisma.onAccountOrder.findUniqueOrThrow({ where: { id } });
      }
      let outcome: StepOutcome;
      switch (row.state) {
        case "REGISTERED":
        case "PENDING_TEMP_TERMS":
          outcome = await stepCleanup(row, snapshot);
          break;
        case "WAITING_FOR_DELIVERY":
        case "INVOICE_SENT":
          outcome = (await settleIfNotPayable(row, snapshot)) ? "MOVED" : "IDLE";
          break;
        case "DELIVERED":
          outcome = await stepTerms(row, snapshot);
          break;
        case "TERMS_SET":
          outcome = await stepInvoice(row, snapshot);
          break;
        case "INVOICE_SENDING": {
          const startedAt = row.invoiceSendingAt?.getTime() ?? 0;
          if (Date.now() - startedAt < IN_FLIGHT_SEND_GRACE_MS) return row; // maybe still in flight elsewhere
          outcome = await resolveUncertainSend(row, snapshot);
          break;
        }
        default:
          return row;
      }
      if (outcome === "IDLE") return prisma.onAccountOrder.findUniqueOrThrow({ where: { id } });
      snapshot = null; // every next step reads Shopify fresh
    } catch (error) {
      await recordFailure(row, error);
      return prisma.onAccountOrder.findUniqueOrThrow({ where: { id } });
    }
  }
  return prisma.onAccountOrder.findUniqueOrThrow({ where: { id } });
}

// ── delivery triggers ────────────────────────────────────────────────

export type RecordDeliveryInput = {
  orderGid: string;
  triggerSource: OnAccountTriggerSource;
  /** e.g. "offerteapp" (pickup audit), "source2pos", "crm", "offerteapp-api" */
  source: string;
  /** Stable id from the source; the (source, eventKey) pair is deduplicated. */
  eventKey: string;
  kind: string;
  occurredAt: Date;
  actorUserId: string | null;
  /** v1: a partial delivery is never invoiced automatically. */
  partial?: boolean;
  metadata?: Record<string, unknown>;
  skipReconcile?: boolean;
};

export type RecordDeliveryResult =
  | { outcome: "APPLIED"; id: string; state: OnAccountState }
  | { outcome: "DUPLICATE" | "IGNORED_ALREADY_DELIVERED" | "IGNORED_NOT_ELIGIBLE" | "MANUAL_REVIEW"; id: string; state: OnAccountState }
  | { outcome: "NOT_ON_ACCOUNT" | "ORDER_NOT_FOUND" };

const DELIVERABLE_STATES: OnAccountState[] = ["REGISTERED", "PENDING_TEMP_TERMS", "WAITING_FOR_DELIVERY"];

/**
 * Records the real handover moment ONCE. Checks the exact order on Shopify
 * first (exists, tagged, still PENDING with an outstanding balance, not
 * cancelled, no deliveredAt yet). Every event is stored, applied or not.
 */
export async function recordDelivery(input: RecordDeliveryInput): Promise<RecordDeliveryResult> {
  let row = await prisma.onAccountOrder.findUnique({ where: { shopifyOrderGid: input.orderGid } });
  if (!row) {
    const registered = await registerOnAccountOrder(input.orderGid, "API", input.actorUserId);
    if (!registered.registered) return { outcome: registered.reason };
    row = await prisma.onAccountOrder.findUniqueOrThrow({ where: { id: registered.id } });
  }

  const existing = await prisma.onAccountEvent.findUnique({ where: { source_eventKey: { source: input.source, eventKey: input.eventKey } } });
  // Already applied, or the order is already delivered: a true duplicate.
  // An event that was only IGNORED_NOT_ELIGIBLE earlier (e.g. the order was
  // in MANUAL_REVIEW) is evaluated again, so a fixed order still gets it.
  if (existing && (existing.outcome === "APPLIED" || row.deliveredAt)) return { outcome: "DUPLICATE", id: row.id, state: row.state };

  const storeEvent = async (outcome: string) => {
    if (existing) {
      await prisma.onAccountEvent.update({ where: { id: existing.id }, data: { outcome } });
      return true;
    }
    try {
      await prisma.onAccountEvent.create({
        data: {
          onAccountOrderId: row!.id,
          source: input.source,
          eventKey: input.eventKey,
          kind: input.kind,
          occurredAt: input.occurredAt,
          outcome,
          actorUserId: input.actorUserId,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonObject,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  };

  if (row.deliveredAt || !DELIVERABLE_STATES.includes(row.state)) {
    const stored = await storeEvent(row.deliveredAt ? "IGNORED_ALREADY_DELIVERED" : "IGNORED_NOT_ELIGIBLE");
    return { outcome: stored ? (row.deliveredAt ? "IGNORED_ALREADY_DELIVERED" : "IGNORED_NOT_ELIGIBLE") : "DUPLICATE", id: row.id, state: row.state };
  }

  const snapshot = await readOnAccountOrder(row.shopifyOrderGid);
  if (
    !snapshot ||
    snapshot.cancelledAt ||
    !snapshot.tags.includes(ON_ACCOUNT_TAG) ||
    snapshot.displayFinancialStatus !== "PENDING" ||
    amount(snapshot.outstanding) <= 0
  ) {
    const stored = await storeEvent("IGNORED_NOT_ELIGIBLE");
    if (snapshot) await reconcileOnAccountOrder(row.id, { snapshot });
    const now = await prisma.onAccountOrder.findUniqueOrThrow({ where: { id: row.id } });
    return { outcome: stored ? "IGNORED_NOT_ELIGIBLE" : "DUPLICATE", id: row.id, state: now.state };
  }

  if (input.partial) {
    const stored = await storeEvent("MANUAL_REVIEW_PARTIAL");
    if (!stored) return { outcome: "DUPLICATE", id: row.id, state: row.state };
    await toReview(row, "PARTIAL_DELIVERY", input.kind);
    return { outcome: "MANUAL_REVIEW", id: row.id, state: "MANUAL_REVIEW" };
  }

  // Term snapshot is needed to compute dueAt; resolve it now if the order
  // was never cleaned up yet (e.g. Shopify was down at registration).
  let termDays = row.termDays;
  let reviewReason: ReviewReason | null = null;
  if (termDays === null) {
    const term = resolveSnapshotTermDays(snapshot);
    if ("error" in term) reviewReason = term.error;
    else termDays = term.termDays;
  }

  if (!(await storeEvent("APPLIED"))) return { outcome: "DUPLICATE", id: row.id, state: row.state };

  // deliveredAt exactly once: only if still NULL and still in a deliverable state.
  const target: OnAccountState = reviewReason ? "MANUAL_REVIEW" : "DELIVERED";
  assertTransition(row.state, target);
  const written = await prisma.onAccountOrder.updateMany({
    where: { id: row.id, deliveredAt: null, state: { in: DELIVERABLE_STATES } },
    data: {
      deliveredAt: input.occurredAt,
      triggerSource: input.triggerSource,
      triggerEventId: `${input.source}:${input.eventKey}`,
      deliveredByUserId: input.actorUserId,
      termDays,
      state: target,
      reviewReason,
      lastError: reviewReason,
      attempts: 0,
      nextAttemptAt: null,
    },
  });
  if (written.count !== 1) {
    await prisma.onAccountEvent.update({
      where: { source_eventKey: { source: input.source, eventKey: input.eventKey } },
      data: { outcome: "IGNORED_ALREADY_DELIVERED" },
    });
    const now = await prisma.onAccountOrder.findUniqueOrThrow({ where: { id: row.id } });
    return { outcome: "IGNORED_ALREADY_DELIVERED", id: row.id, state: now.state };
  }

  await logAudit({
    userId: input.actorUserId,
    action: input.triggerSource === "MANUAL_INVOICE" ? "on_account.invoice_requested" : "on_account.delivery_recorded",
    entityType: "OnAccountOrder",
    entityId: row.id,
    metadata: {
      orderGid: row.shopifyOrderGid,
      triggerSource: input.triggerSource,
      deliveredAt: input.occurredAt.toISOString(),
      event: `${input.source}:${input.eventKey}`,
      termDays,
    },
  });

  const final = input.skipReconcile ? await prisma.onAccountOrder.findUniqueOrThrow({ where: { id: row.id } }) : await reconcileOnAccountOrder(row.id);
  return { outcome: "APPLIED", id: row.id, state: final.state };
}

// ── paid / review / worker ───────────────────────────────────────────

/** orders/paid webhook: stop everything for this order. */
export async function markOnAccountOrderPaid(orderGid: string): Promise<{ updated: boolean }> {
  const row = await prisma.onAccountOrder.findUnique({ where: { shopifyOrderGid: orderGid } });
  if (!row || TERMINAL_STATES.has(row.state)) return { updated: false };
  const snapshot = await readOnAccountOrder(orderGid);
  if (!snapshot) return { updated: false };
  if (snapshot.displayFinancialStatus === "PAID" || amount(snapshot.outstanding) <= 0) {
    const moved = await moveState(row, "PAID", { paidAt: new Date(), nextAttemptAt: null });
    return { updated: moved };
  }
  await reconcileOnAccountOrder(row.id, { snapshot });
  return { updated: false };
}

export type ReviewResolution =
  /** "Mail is verstuurd" — after checking Shopify by hand. */
  | "MARK_INVOICE_SENT"
  /** "Mail is niet verstuurd" — allow exactly one new send. */
  | "RETRY_INVOICE"
  /** Problem fixed on Shopify (term, terms, tag) — start over from the top. */
  | "RETRY_FROM_START"
  | "MARK_CANCELLED";

export async function resolveReview(id: string, resolution: ReviewResolution, actorUserId: string, note: string): Promise<OnAccountOrder> {
  const row = await prisma.onAccountOrder.findUniqueOrThrow({ where: { id } });
  if (row.state !== "MANUAL_REVIEW") throw new Error("Deze order staat niet op handmatige controle.");
  const reset = { reviewReason: null, lastError: null, attempts: 0, nextAttemptAt: null };
  let to: OnAccountState;
  let data: Prisma.OnAccountOrderUpdateManyMutationInput = reset;
  switch (resolution) {
    case "MARK_INVOICE_SENT":
      if (!row.dueAt) throw new Error("Er is nog geen vervaldatum gezet.");
      to = "INVOICE_SENT";
      data = { ...reset, invoiceSentAt: row.invoiceSendingAt ?? new Date() };
      break;
    case "RETRY_INVOICE":
      if (!row.dueAt) throw new Error("Er is nog geen vervaldatum gezet.");
      to = "TERMS_SET";
      data = { ...reset, invoiceSendingAt: null };
      break;
    case "RETRY_FROM_START":
      to = row.deliveredAt ? "DELIVERED" : "REGISTERED";
      data = { ...reset, ...(row.deliveredAt ? {} : { termDays: null }) };
      break;
    case "MARK_CANCELLED":
      to = "CANCELLED";
      data = { ...reset, cancelledAt: new Date() };
      break;
  }
  const moved = await moveState(row, to, data);
  if (!moved) throw new Error("De order is intussen gewijzigd — ververs de pagina.");
  await logAudit({
    userId: actorUserId,
    action: "on_account.review_resolved",
    entityType: "OnAccountOrder",
    entityId: id,
    metadata: { orderGid: row.shopifyOrderGid, resolution, previousReason: row.reviewReason, note: note.slice(0, 500) },
  });
  if (to === "INVOICE_SENT") {
    await setOrderInvoiceSentAt(row.shopifyOrderGid, row.invoiceSendingAt ?? new Date()).catch(() => undefined);
  }
  return TERMINAL_STATES.has(to) || to === "INVOICE_SENT" ? prisma.onAccountOrder.findUniqueOrThrow({ where: { id } }) : reconcileOnAccountOrder(id);
}

export type PickupEventSource = (orderGid: string) => Promise<{ id: string; occurredAt: string }[] | null>;

/**
 * One worker pass (called by the scheduled internal route): advance every
 * due row, and poll WAITING_FOR_DELIVERY orders for a pickup handover.
 */
export async function runOnAccountWorker(options: { limit?: number; pickupEvents?: PickupEventSource; deadlineAt?: number } = {}) {
  const limit = options.limit ?? 25;
  const now = new Date();
  // Soft deadline: no NEW order is started after it (one already running
  // finishes; every step is a compare-and-set, so a late finish is safe).
  const pastDeadline = () => options.deadlineAt !== undefined && Date.now() >= options.deadlineAt;
  let stoppedByDeadline = false;
  const due = await prisma.onAccountOrder.findMany({
    where: {
      state: { in: ["REGISTERED", "PENDING_TEMP_TERMS", "DELIVERED", "TERMS_SET", "INVOICE_SENDING"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  const advanced: { id: string; state: OnAccountState }[] = [];
  for (const row of due) {
    if (pastDeadline()) {
      stoppedByDeadline = true;
      break;
    }
    const final = await reconcileOnAccountOrder(row.id);
    advanced.push({ id: row.id, state: final.state });
  }

  const polled: { id: string; outcome: string }[] = [];
  if (options.pickupEvents && !stoppedByDeadline) {
    const waiting = await prisma.onAccountOrder.findMany({
      where: { state: "WAITING_FOR_DELIVERY", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
    for (const row of waiting) {
      if (pastDeadline()) {
        stoppedByDeadline = true;
        break;
      }
      await prisma.onAccountOrder.updateMany({
        where: { id: row.id, state: "WAITING_FOR_DELIVERY" },
        data: { nextAttemptAt: new Date(Date.now() + PICKUP_POLL_INTERVAL_MS) },
      });
      try {
        const events = await options.pickupEvents(row.shopifyOrderGid);
        if (events === null) {
          polled.push({ id: row.id, outcome: "SOURCE_UNAVAILABLE" });
          continue;
        }
        const first = events[0];
        if (!first) {
          await reconcileOnAccountOrder(row.id); // paid/cancelled meanwhile?
          polled.push({ id: row.id, outcome: "NO_EVENT" });
          continue;
        }
        const result = await recordDelivery({
          orderGid: row.shopifyOrderGid,
          triggerSource: "PICKUP_HANDOVER",
          source: "offerteapp",
          eventKey: first.id,
          kind: "CUSTOMER_PICKUP_HANDED_OVER",
          occurredAt: new Date(first.occurredAt),
          actorUserId: null,
        });
        polled.push({ id: row.id, outcome: result.outcome });
      } catch (error) {
        polled.push({ id: row.id, outcome: `ERROR ${shortError(error)}` });
      }
    }
  }
  return { advanced, polled, stoppedByDeadline };
}

// ── "Betaallink nu versturen" (OfferteApp, via the integration API) ──

export type InvoiceNowResult = {
  outcome: RecordDeliveryResult["outcome"];
  row: OnAccountOrder | null;
};

/**
 * Manual escape: the term starts NOW (deliveredAt = invoice moment,
 * triggerSource MANUAL_INVOICE); a later logistics event is then ignored
 * because deliveredAt is already set. The same requestId twice is a no-op.
 */
export async function requestInvoiceNow(input: {
  orderGid: string;
  requestId: string;
  requestedBy: { name: string | null; email: string | null };
  source: string;
}): Promise<InvoiceNowResult> {
  const result = await recordDelivery({
    orderGid: input.orderGid,
    triggerSource: "MANUAL_INVOICE",
    source: input.source,
    eventKey: input.requestId,
    kind: "MANUAL_INVOICE",
    occurredAt: new Date(),
    actorUserId: null,
    metadata: { requestedBy: input.requestedBy },
  });
  const row = await prisma.onAccountOrder.findUnique({ where: { shopifyOrderGid: input.orderGid } });
  return { outcome: result.outcome, row };
}

// ── CRM staff actions ────────────────────────────────────────────────

export class OnAccountActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Bezorging v1: a staff member confirms "Afgeleverd bij klant". The moment
 * may be earlier than now (delivered yesterday) but never in the future and
 * never before the order was registered. One manual delivery per order.
 */
export async function recordManualDelivery(id: string, deliveredAt: Date, actorUserId: string): Promise<RecordDeliveryResult> {
  const row = await prisma.onAccountOrder.findUnique({ where: { id } });
  if (!row) throw new OnAccountActionError("Order niet gevonden.", 404);
  if (Number.isNaN(deliveredAt.getTime())) throw new OnAccountActionError("Ongeldig levermoment.");
  if (deliveredAt.getTime() > Date.now() + 60_000) throw new OnAccountActionError("Het levermoment kan niet in de toekomst liggen.");
  if (deliveredAt.getTime() < row.createdAt.getTime() - 24 * 60 * 60_000) {
    throw new OnAccountActionError("Het levermoment ligt vóór het aanmaken van de order.");
  }
  return recordDelivery({
    orderGid: row.shopifyOrderGid,
    triggerSource: "MANUAL_DELIVERY",
    source: "crm",
    eventKey: `manual-delivery:${row.id}`,
    kind: "MANUAL_DELIVERY",
    occurredAt: deliveredAt,
    actorUserId,
  });
}

export async function listOnAccountOrders(limit = 300) {
  return prisma.onAccountOrder.findMany({
    orderBy: [{ updatedAt: "desc" }],
    take: limit,
    include: { events: { orderBy: { createdAt: "desc" }, take: 5 } },
  });
}

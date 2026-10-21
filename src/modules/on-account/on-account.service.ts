import "server-only";
import { e2eFaultActive, InjectedE2EFault } from "./e2e-fault";
import { Prisma, type OnAccountOrder, type OnAccountState, type OnAccountTriggerSource } from "@/generated/prisma";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { createHash, randomUUID } from "crypto";
import { readOnAccountOrder, type OnAccountOrderSnapshot } from "@/integrations/shopify/on-account-read";
import { readInvoiceOrder, readPaymentLink } from "@/integrations/shopify/invoice-read";
import {
  createFixedPaymentTerms,
  deleteOrderPaymentTerms,
  setOrderInvoiceSentAt,
  updateToFixedPaymentTerms,
} from "@/integrations/shopify/on-account";
import { fetchCompanyProfile, invoiceMailStatus, sendInvoiceMail, type InvoiceMailOutcome } from "@/integrations/offerteapp/invoice-mail";
import { downloadObject, uploadObject } from "@/integrations/storage/r2";
import { computeDueAt, InvalidTermDaysError, ON_ACCOUNT_TAG, parseTermDays, sameInstant } from "./rules";
import { buildInvoiceSnapshot, InvoiceSnapshotError, snapshotSha256, toCents, type InvoiceSnapshot } from "./invoice/snapshot";
import { renderInvoicePdf } from "./invoice/render";
import { buildInvoiceMail, isAcceptablePaymentUrl } from "./invoice/mail";
import {
  assertTransition,
  MAX_ATTEMPTS,
  nextAttemptDelayMs,
  REVIEW_REASON_LABELS,
  TERMINAL_STATES,
  WORKABLE_STATES,
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

// ── Phase I: the definitive invoice + ONE Stones4U invoice mail ─────
//
// TERMS_SET -> INVOICE_GENERATING -> INVOICE_READY -> INVOICE_SENDING -> INVOICE_SENT
//
// - Invoice number = the Shopify order number. Exactly one OnAccountInvoice
//   per order (unique on order, GID, number and sendKey); once stored, the
//   snapshot and PDF are reused, never rebuilt.
// - Generating has no external effect; a failure returns to TERMS_SET.
// - The mail goes through OfferteApp (Stones4U's mail provider) with the
//   invoice's sendKey: OfferteApp mails at most once per key, so a retry or
//   an unknown outcome is resolved by asking OfferteApp, never by mailing
//   again. An SMTP hand-over that may have succeeded -> MANUAL_REVIEW.
// - Shopify's orderInvoiceSend is NOT used by this automatic flow (the
//   customer would get two mails). Rows still in INVOICE_SENDING from the
//   pre-Phase I flow keep being resolved from Shopify's marker/event.

const INVOICE_GENERATING_GRACE_MS = 2 * 60_000;

function paymentLinkHosts(): string[] {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  const extra = (process.env.ON_ACCOUNT_PAYMENT_LINK_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return [...(shop ? [shop] : []), ...extra];
}

async function suppressMail(orderId: string, reason: string): Promise<void> {
  await prisma.onAccountInvoice.updateMany({ where: { onAccountOrderId: orderId, sentAt: null }, data: { mailSuppressedReason: reason } });
}

/** TERMS_SET: build the ONE definitive invoice (fresh Shopify read -> snapshot -> PDF -> stored). */
async function stepGenerateInvoice(row: OnAccountOrder, snapshot: OnAccountOrderSnapshot): Promise<StepOutcome> {
  if (snapshot.cancelledAt) return (await moveState(row, "CANCELLED", { cancelledAt: new Date(snapshot.cancelledAt), nextAttemptAt: null })) ? "MOVED" : "IDLE";
  if (snapshot.metafields.invoiceSentAt) {
    // Pre-Phase I marker: an invoice already went out — adopt, never mail again.
    await markInvoiceSent(row, new Date(snapshot.metafields.invoiceSentAt), null, "shopify_marker");
    return "MOVED";
  }
  if (!row.deliveredAt || !row.dueAt || !row.termDays) {
    await toReview(row, "DUE_DATE_CONFLICT", "levering/vervaldatum/termijn ontbreekt op de rij");
    return "MOVED";
  }
  const existing = await prisma.onAccountInvoice.findUnique({ where: { onAccountOrderId: row.id } });
  if (existing) return (await moveState(row, "INVOICE_READY", { attempts: 0, lastError: null })) ? "MOVED" : "IDLE";

  // The claim: exactly one worker builds the invoice.
  const claimedAt = new Date();
  if (!(await moveState(row, "INVOICE_GENERATING", { invoiceGeneratingAt: claimedAt }))) return "IDLE";
  const generating: OnAccountOrder = { ...row, state: "INVOICE_GENERATING", invoiceGeneratingAt: claimedAt };

  try {
    const order = await readInvoiceOrder(row.shopifyOrderGid);
    if (!order) throw new Error("ORDER_NOT_FOUND");
    if (order.cancelledAt) {
      await moveState(generating, "CANCELLED", { cancelledAt: new Date(order.cancelledAt), nextAttemptAt: null });
      return "MOVED";
    }
    const company = await fetchCompanyProfile();
    let invoice: InvoiceSnapshot;
    try {
      invoice = buildInvoiceSnapshot({
        order,
        company,
        termDays: row.termDays,
        deliveredAt: row.deliveredAt,
        dueAt: row.dueAt,
        issuedAt: new Date(),
      });
    } catch (error) {
      if (!(error instanceof InvoiceSnapshotError)) throw error;
      await toReview(generating, error.reason, error.message);
      return "MOVED";
    }
    const paidAlready = order.displayFinancialStatus === "PAID" || invoice.totals.outstandingCents <= 0;
    if (!paidAlready && invoice.totals.outstandingCents !== invoice.totals.totalCents) {
      await toReview(generating, "OUTSTANDING_MISMATCH", "openstaand bedrag wijkt af van het ordertotaal (deelbetaling?)");
      return "MOVED";
    }
    if (e2eFaultActive("invoice_pdf_render_fails", row.shopifyOrderGid)) throw new InjectedE2EFault("invoice_pdf_render_fails");
    const pdf = await renderInvoicePdf({ snapshot: invoice, logo: company.logo });
    const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
    // Content-addressed: the same key always holds the same bytes.
    const storageKey = `invoices/${invoice.invoiceDate.slice(0, 4)}/${invoice.invoiceNumber}/${pdfSha256}.pdf`;
    await uploadObject({ storageKey, body: pdf, mimeType: "application/pdf" });

    const created = await prisma.onAccountInvoice.create({
      data: {
        onAccountOrderId: row.id,
        shopifyOrderGid: row.shopifyOrderGid,
        invoiceNumber: invoice.invoiceNumber,
        shopifyOrderName: invoice.shopifyOrderName,
        invoiceDate: invoice.invoiceDate,
        deliveredAt: row.deliveredAt,
        termDays: row.termDays,
        dueAt: row.dueAt,
        currency: invoice.currency,
        totalAmount: new Prisma.Decimal(invoice.totals.totalCents).div(100),
        taxAmount: new Prisma.Decimal(invoice.totals.vatCents).div(100),
        outstandingAmount: new Prisma.Decimal(invoice.totals.outstandingCents).div(100),
        snapshot: invoice as unknown as Prisma.InputJsonObject,
        snapshotSha256: snapshotSha256(invoice),
        pdfSha256,
        pdfSize: pdf.length,
        storageKey,
        sendKey: randomUUID(),
        mailSuppressedReason: paidAlready ? "PAID_BEFORE_SEND" : null,
      },
    });
    await logAudit({
      userId: null,
      action: "on_account.invoice_generated",
      entityType: "OnAccountOrder",
      entityId: row.id,
      metadata: {
        orderGid: row.shopifyOrderGid,
        invoiceNumber: created.invoiceNumber,
        invoiceDate: created.invoiceDate,
        totalCents: invoice.totals.totalCents,
        pdfSha256,
        storageKey,
        paidAlready,
      },
    });
    if (paidAlready) {
      // Paid before the mail: the invoice exists (bookkeeping), no payment mail.
      await moveState(generating, "PAID", { paidAt: new Date(), nextAttemptAt: null, invoiceGeneratingAt: null });
      return "MOVED";
    }
    await moveState(generating, "INVOICE_READY", { invoiceGeneratingAt: null, attempts: 0, lastError: null, nextAttemptAt: null });
    return "MOVED";
  } catch (error) {
    // Nothing left this system: safe to retry later from TERMS_SET.
    await moveState(generating, "TERMS_SET", { invoiceGeneratingAt: null });
    await recordFailure({ ...generating, state: "TERMS_SET" }, error);
    return "IDLE";
  }
}

async function markStonesInvoiceMailSent(row: OnAccountOrder, invoiceId: string, recipient: string, messageId: string | null, how: string): Promise<void> {
  const sentAt = new Date();
  await prisma.onAccountInvoice.updateMany({
    where: { id: invoiceId, sentAt: null },
    data: { sentAt, mailRecipient: recipient, mailMessageId: messageId },
  });
  await markInvoiceSent(row, sentAt, recipient, how);
}

/** INVOICE_SENDING (Phase I): what does OfferteApp know about this sendKey? Never mails. */
async function resolveInvoiceMail(row: OnAccountOrder, invoice: { id: string; sendKey: string }): Promise<StepOutcome> {
  const status = await invoiceMailStatus(invoice.sendKey);
  switch (status.status) {
    case "SENT":
      await markStonesInvoiceMailSent(row, invoice.id, row.invoiceRecipient ?? "", status.messageId, "stones4u_invoice_mail_status");
      return "MOVED";
    case "NONE":
    case "NOT_SENT":
      // Nothing (accepted) for this key: the same key may be mailed again.
      await moveState(row, "INVOICE_READY", { invoiceSendingAt: null });
      await recordFailure({ ...row, state: "INVOICE_READY" }, new Error(`factuurmail niet verstuurd (${status.status})`));
      return "IDLE";
    case "UNCERTAIN":
      await toReview(row, "INVOICE_SEND_UNCERTAIN", status.detail ?? "SMTP-overdracht onzeker");
      return "MOVED";
    default:
      // IN_PROGRESS / UNKNOWN: ask again later, never resend.
      await recordFailure(row, new Error(`factuurmail-status ${status.status}: ${status.detail ?? ""}`));
      return "IDLE";
  }
}

/** INVOICE_READY: re-check the order, fetch Shopify's payment URL, mail the stored PDF once. */
async function stepSendInvoiceMail(row: OnAccountOrder, snapshot: OnAccountOrderSnapshot): Promise<StepOutcome> {
  const invoice = await prisma.onAccountInvoice.findUnique({ where: { onAccountOrderId: row.id } });
  if (!invoice) {
    await toReview(row, "INVOICE_PDF_INTEGRITY", "factuurrecord ontbreekt");
    return "MOVED";
  }
  if (snapshot.cancelledAt) {
    await suppressMail(row.id, "CANCELLED_BEFORE_SEND");
    return (await moveState(row, "CANCELLED", { cancelledAt: new Date(snapshot.cancelledAt), nextAttemptAt: null })) ? "MOVED" : "IDLE";
  }
  if (snapshot.displayFinancialStatus === "PAID" || amount(snapshot.outstanding) <= 0) {
    await suppressMail(row.id, "PAID_BEFORE_SEND");
    return (await moveState(row, "PAID", { paidAt: new Date(), nextAttemptAt: null })) ? "MOVED" : "IDLE";
  }
  if (amount(snapshot.outstanding) !== toCents(invoice.outstandingAmount.toFixed(2))) {
    await toReview(row, "OUTSTANDING_MISMATCH", "openstaand bedrag gewijzigd sinds de factuur");
    return "MOVED";
  }
  const recipient = snapshot.email ?? snapshot.customerEmail;
  if (!recipient) {
    await toReview(row, "NO_INVOICE_RECIPIENT");
    return "MOVED";
  }

  // Shopify's own payment URL, read now — never constructed, never logged.
  const link = e2eFaultActive("payment_link_unavailable", row.shopifyOrderGid) ? null : await readPaymentLink(row.shopifyOrderGid);
  const url = link?.url ?? null;
  if (!url) {
    await recordFailure(row, new Error("PAYMENT_LINK_UNAVAILABLE: Shopify gaf geen betaal-URL"));
    return "IDLE";
  }
  const legacyId = row.shopifyOrderGid.split("/").pop() ?? "";
  if (!paymentLinkHosts().some((host) => isAcceptablePaymentUrl(url, host, legacyId))) {
    await toReview(row, "PAYMENT_LINK_UNAVAILABLE", "betaal-URL hoort niet bij deze order/shop");
    return "MOVED";
  }

  const pdf = await downloadObject(invoice.storageKey);
  if (createHash("sha256").update(pdf).digest("hex") !== invoice.pdfSha256) {
    await toReview(row, "INVOICE_PDF_INTEGRITY", "checksum van de opgeslagen PDF klopt niet");
    return "MOVED";
  }
  const mail = buildInvoiceMail(invoice.snapshot as unknown as InvoiceSnapshot, url);

  // The claim: exactly one worker mails this invoice.
  const sendingAt = new Date();
  if (!(await moveState(row, "INVOICE_SENDING", { invoiceSendingAt: sendingAt, invoiceRecipient: recipient }))) return "IDLE";
  const sending: OnAccountOrder = { ...row, state: "INVOICE_SENDING", invoiceSendingAt: sendingAt, invoiceRecipient: recipient };

  let result: InvoiceMailOutcome;
  if (e2eFaultActive("invoice_mail_timeout_before_send", row.shopifyOrderGid)) {
    result = { status: "UNKNOWN", detail: "E2E injected: timeout before OfferteApp received the request" };
  } else if (e2eFaultActive("invoice_mail_uncertain", row.shopifyOrderGid)) {
    result = { status: "UNCERTAIN", detail: "E2E injected: SMTP hand-over uncertain" };
  } else {
    result = await sendInvoiceMail({
      sendKey: invoice.sendKey,
      to: recipient,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachment: { filename: mail.filename, contentBase64: pdf.toString("base64"), sha256: invoice.pdfSha256 },
    });
  }

  switch (result.status) {
    case "SENT":
      // E2E only: the mail went out, the process "dies" before recording it.
      if (e2eFaultActive("crash_after_invoice_send", row.shopifyOrderGid)) throw new InjectedE2EFault("crash_after_invoice_send");
      await markStonesInvoiceMailSent(sending, invoice.id, recipient, result.messageId, "stones4u_invoice_mail");
      return "MOVED";
    case "NOT_SENT":
      await moveState(sending, "INVOICE_READY", { invoiceSendingAt: null });
      await recordFailure({ ...sending, state: "INVOICE_READY" }, new Error(`factuurmail niet verstuurd: ${result.detail ?? ""}`));
      return "IDLE";
    case "REJECTED":
      await toReview(sending, "INVOICE_MAIL_REJECTED", result.detail ?? undefined);
      return "MOVED";
    case "UNCERTAIN":
      await toReview(sending, "INVOICE_SEND_UNCERTAIN", result.detail ?? undefined);
      return "MOVED";
    case "IN_PROGRESS":
      return "IDLE";
    case "UNKNOWN":
      await prisma.onAccountOrder.update({ where: { id: row.id }, data: { lastError: `INVOICE_MAIL_OUTCOME_UNKNOWN: ${result.detail ?? ""}`.slice(0, 300) } });
      return resolveInvoiceMail(sending, invoice);
  }
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
          outcome = await stepGenerateInvoice(row, snapshot);
          break;
        case "INVOICE_GENERATING": {
          // Only a crashed generator leaves a row here; nothing left this system.
          const startedAt = row.invoiceGeneratingAt?.getTime() ?? 0;
          if (Date.now() - startedAt < INVOICE_GENERATING_GRACE_MS) return row;
          outcome = (await moveState(row, "TERMS_SET", { invoiceGeneratingAt: null })) ? "MOVED" : "IDLE";
          break;
        }
        case "INVOICE_READY":
          outcome = await stepSendInvoiceMail(row, snapshot);
          break;
        case "INVOICE_SENDING": {
          const startedAt = row.invoiceSendingAt?.getTime() ?? 0;
          if (Date.now() - startedAt < IN_FLIGHT_SEND_GRACE_MS) return row; // maybe still in flight elsewhere
          const invoice = await prisma.onAccountInvoice.findUnique({ where: { onAccountOrderId: row.id } });
          outcome = invoice ? await resolveInvoiceMail(row, invoice) : await resolveUncertainSend(row, snapshot);
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
    case "RETRY_INVOICE": {
      if (!row.dueAt) throw new Error("Er is nog geen vervaldatum gezet.");
      const invoice = await prisma.onAccountInvoice.findUnique({ where: { onAccountOrderId: row.id } });
      if (invoice) {
        if (invoice.sentAt) throw new Error("Deze factuur is al verstuurd.");
        // A human checked: the mail did NOT go out. A new send key allows
        // exactly one new mail of the SAME stored invoice.
        await prisma.onAccountInvoice.update({ where: { id: invoice.id }, data: { sendKey: randomUUID() } });
        to = "INVOICE_READY";
      } else {
        to = "TERMS_SET";
      }
      data = { ...reset, invoiceSendingAt: null };
      break;
    }
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
      // One list for "the worker may advance this" (state-machine.ts), so a new
      // state can never be forgotten here again.
      state: { in: [...WORKABLE_STATES] },
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
    include: { events: { orderBy: { createdAt: "desc" }, take: 5 }, invoice: true },
  });
}

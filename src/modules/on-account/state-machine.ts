// Op rekening v1 — explicit state machine (pure). Every state change in the
// service goes through assertTransition(), and the database update is always
// a compare-and-set on the expected current state (see on-account.service.ts),
// so two workers can never both advance the same order.
import type { OnAccountState } from "@/generated/prisma";

export const ON_ACCOUNT_STATES = [
  "REGISTERED",
  "PENDING_TEMP_TERMS",
  "WAITING_FOR_DELIVERY",
  "DELIVERED",
  "TERMS_SET",
  "INVOICE_SENDING",
  "INVOICE_SENT",
  "PAID",
  "CANCELLED",
  "MANUAL_REVIEW",
] as const satisfies readonly OnAccountState[];

/** No further automatic work, ever. */
export const TERMINAL_STATES: ReadonlySet<OnAccountState> = new Set(["PAID", "CANCELLED"]);

/** States the worker may pick up and advance (with backoff). */
export const WORKABLE_STATES: ReadonlySet<OnAccountState> = new Set([
  "REGISTERED",
  "PENDING_TEMP_TERMS",
  "DELIVERED",
  "TERMS_SET",
  "INVOICE_SENDING",
]);

const TRANSITIONS: Record<OnAccountState, readonly OnAccountState[]> = {
  REGISTERED: ["PENDING_TEMP_TERMS", "WAITING_FOR_DELIVERY", "DELIVERED", "PAID", "CANCELLED", "MANUAL_REVIEW"],
  PENDING_TEMP_TERMS: ["WAITING_FOR_DELIVERY", "DELIVERED", "PAID", "CANCELLED", "MANUAL_REVIEW"],
  WAITING_FOR_DELIVERY: ["DELIVERED", "PAID", "CANCELLED", "MANUAL_REVIEW"],
  DELIVERED: ["TERMS_SET", "PAID", "CANCELLED", "MANUAL_REVIEW"],
  // TERMS_SET -> INVOICE_SENT only when Shopify's own invoice_sent_at marker
  // already says it was sent (adopt, never send a second time).
  TERMS_SET: ["INVOICE_SENDING", "INVOICE_SENT", "PAID", "CANCELLED", "MANUAL_REVIEW"],
  // An uncertain send never goes back to TERMS_SET automatically: that would
  // allow a second mail. Only a verified non-send (Shopify userError) may.
  INVOICE_SENDING: ["INVOICE_SENT", "TERMS_SET", "PAID", "CANCELLED", "MANUAL_REVIEW"],
  INVOICE_SENT: ["PAID", "CANCELLED", "MANUAL_REVIEW"],
  PAID: [],
  CANCELLED: [],
  // Leaving MANUAL_REVIEW is always an explicit human action (resolveReview).
  MANUAL_REVIEW: ["REGISTERED", "WAITING_FOR_DELIVERY", "DELIVERED", "TERMS_SET", "INVOICE_SENT", "PAID", "CANCELLED"],
};

export class InvalidOnAccountTransitionError extends Error {
  constructor(
    readonly from: OnAccountState,
    readonly to: OnAccountState,
  ) {
    super(`Ongeldige statusovergang ${from} -> ${to}.`);
  }
}

export function canTransition(from: OnAccountState, to: OnAccountState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OnAccountState, to: OnAccountState): void {
  if (!canTransition(from, to)) throw new InvalidOnAccountTransitionError(from, to);
}

export type ReviewReason =
  | "TERM_DAYS_MISSING"
  | "TERM_DAYS_INVALID"
  | "UNEXPECTED_PAYMENT_TERMS"
  | "NOT_PENDING"
  | "OUTSTANDING_MISMATCH"
  | "NO_INVOICE_RECIPIENT"
  | "INVOICE_SEND_UNCERTAIN"
  | "DUE_DATE_CONFLICT"
  | "PARTIAL_DELIVERY"
  | "ORDER_NOT_FOUND"
  | "NOT_ON_ACCOUNT"
  | "RETRIES_EXHAUSTED";

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  TERM_DAYS_MISSING: "Betaaltermijn ontbreekt op de order",
  TERM_DAYS_INVALID: "Betaaltermijn op de order is ongeldig",
  UNEXPECTED_PAYMENT_TERMS: "Order heeft onverwachte betaalvoorwaarden",
  NOT_PENDING: "Order staat niet (meer) op 'betaling in behandeling'",
  OUTSTANDING_MISMATCH: "Openstaand bedrag klopt niet met het ordertotaal",
  NO_INVOICE_RECIPIENT: "Geen e-mailadres om de betaallink naartoe te sturen",
  INVOICE_SEND_UNCERTAIN: "Onbekend of de betaallink is verstuurd — controleer in Shopify",
  DUE_DATE_CONFLICT: "Er staat al een andere vervaldatum op de order",
  PARTIAL_DELIVERY: "Gedeeltelijke levering — handmatig afhandelen",
  ORDER_NOT_FOUND: "Order niet gevonden in Shopify",
  NOT_ON_ACCOUNT: "Order is niet gemarkeerd als op rekening",
  RETRIES_EXHAUSTED: "Te vaak mislukt — handmatig controleren",
};

/** Retry backoff: 1, 2, 4, 8 … minutes, capped at 6 hours; MANUAL_REVIEW after MAX_ATTEMPTS. */
export const MAX_ATTEMPTS = 10;
export function nextAttemptDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts) * 60_000, 6 * 60 * 60_000);
}

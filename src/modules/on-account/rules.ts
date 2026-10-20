// Op rekening v1 — pure business rules (no I/O). docs/ON-ACCOUNT-PAYMENT-DUE.md.
//
// Decided by the business (2026-10-20):
// - stones4u.credit_allowed must be exactly true, otherwise no "op rekening".
// - stones4u.payment_term_days empty -> 30; set -> that value.
// - The term is snapshot onto the order at creation and never follows later
//   customer changes.
// - The term starts at the real delivery/pickup moment:
//   dueAt = calendar date of deliveredAt in Europe/Amsterdam + termDays,
//   at 23:59:59 Amsterdam local time (DST-correct).

export const ON_ACCOUNT_TAG = "op-rekening";
export const DEFAULT_TERM_DAYS = 30;
/** Sanity bound for a stored term; anything outside is a data error, not a policy. */
export const MAX_TERM_DAYS = 365;
export const BUSINESS_TIME_ZONE = "Europe/Amsterdam";

export class InvalidTermDaysError extends Error {
  constructor(readonly raw: string) {
    super(`Ongeldige betaaltermijn "${raw}" — verwacht een geheel aantal dagen (1–${MAX_TERM_DAYS}).`);
  }
}

/** Parses a stored term (metafield/attribute string). Empty -> null; invalid -> throws. */
export function parseTermDays(raw: string | null | undefined): number | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (!/^\d+$/.test(value)) throw new InvalidTermDaysError(value);
  const days = Number(value);
  if (days < 1 || days > MAX_TERM_DAYS) throw new InvalidTermDaysError(value);
  return days;
}

export type CustomerCredit =
  | { allowed: false; termDays: null }
  | { allowed: true; termDays: number; termIsDefault: boolean };

/** credit_allowed must be exactly "true"; empty term -> 30. */
export function resolveCustomerCredit(creditAllowed: string | null | undefined, termDays: string | null | undefined): CustomerCredit {
  if ((creditAllowed ?? "").trim() !== "true") return { allowed: false, termDays: null };
  const parsed = parseTermDays(termDays);
  return parsed === null
    ? { allowed: true, termDays: DEFAULT_TERM_DAYS, termIsDefault: true }
    : { allowed: true, termDays: parsed, termIsDefault: false };
}

/** Offset of `zone` from UTC (minutes) at instant `at`. */
function zoneOffsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The calendar date (YYYY-MM-DD) of `at` in Amsterdam. */
export function businessDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE }).format(at);
}

/**
 * dueAt = (Amsterdam calendar date of deliveredAt) + termDays, 23:59:59
 * Amsterdam local time, returned as a UTC instant (whole seconds).
 * Example: delivered 20-10-2026, 30 days -> 19-11-2026 23:59:59 CET = 2026-11-19T22:59:59Z.
 */
export function computeDueAt(deliveredAt: Date, termDays: number): Date {
  if (!Number.isInteger(termDays) || termDays < 1 || termDays > MAX_TERM_DAYS) {
    throw new InvalidTermDaysError(String(termDays));
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate(deliveredAt));
  if (!match) throw new Error("Kon de leverdatum niet bepalen.");
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Wall-clock 23:59:59 on the target day, first read as if it were UTC…
  const wallAsUtc = Date.UTC(y, m - 1, d + termDays, 23, 59, 59);
  // …then shifted by Amsterdam's offset on that day. Evaluating the offset at
  // the shifted instant makes this correct on DST-change days as well.
  const firstGuess = wallAsUtc - zoneOffsetMinutes(new Date(wallAsUtc), BUSINESS_TIME_ZONE) * 60000;
  return new Date(wallAsUtc - zoneOffsetMinutes(new Date(firstGuess), BUSINESS_TIME_ZONE) * 60000);
}

/** Shopify returns "2026-11-19T22:59:59Z"; compare instants at second precision. */
export function sameInstant(a: Date | string | null | undefined, b: Date | string | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.floor(new Date(a).getTime() / 1000) === Math.floor(new Date(b).getTime() / 1000);
}

export function formatDutchDate(at: Date): string {
  return new Intl.DateTimeFormat("nl-NL", { timeZone: BUSINESS_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }).format(at);
}

/** The customer-facing message that accompanies the Shopify invoice mail. */
export function invoiceMessage(input: { termDays: number; dueAt: Date; deliveredAt: Date; triggerSource: string }): string {
  const start =
    input.triggerSource === "MANUAL_INVOICE"
      ? `vandaag (${formatDutchDate(input.deliveredAt)})`
      : `na levering/afhalen op ${formatDutchDate(input.deliveredAt)}`;
  return `Betaaltermijn: ${input.termDays} dagen, gerekend ${start}. Graag betalen uiterlijk ${formatDutchDate(input.dueAt)}. Met de knop in deze mail betaalt u veilig via onze webshop.`;
}

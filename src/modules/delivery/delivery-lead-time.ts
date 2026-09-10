// Phase 6P — the single canonical Stones4U delivery-date policy.
//
// BUSINESS RULE (Fons, this phase): Stones4U does not deliver on Saturday or
// Sunday, weekend days do not count toward the lead time, and there must
// always be TWO COMPLETE BUSINESS DAYS between the reference date and the
// requested delivery date. The earliest allowed date is therefore the THIRD
// business day after the reference date.
//
//   reference Monday    -> Tue(1) Wed(2) -> earliest Thursday
//   reference Friday    -> Mon(1) Tue(2) -> earliest Wednesday (weekend skipped)
//   reference Saturday  -> Mon(1) Tue(2) -> earliest Wednesday (not counted)
//
// This is deliberately NOT "reference + 3 calendar days", and deliberately
// NOT elapsed-hour arithmetic (`72 * 60 * 60 * 1000`): both give wrong
// answers across weekends and across DST transitions.
//
// HOW THE ARITHMETIC AVOIDS TIME ZONES ENTIRELY: an instant is converted
// once to a *civil* date in Europe/Amsterdam ("YYYY-MM-DD"), and every
// calculation after that is pure calendar arithmetic on year/month/day via
// `Date.UTC`. UTC has no DST, so adding a calendar day can never shift by an
// hour, land on the wrong day, or skip one — the 02:00 CET/CEST transitions
// simply cannot affect a date that carries no time at all.
//
// Not in scope this phase (deliberately): public holidays, transport
// capacity, postcode/route restrictions.

/** Every customer-facing delivery date is decided in Stones4U's own zone,
 * never the server's and never the browser's. */
export const DELIVERY_TIME_ZONE = "Europe/Amsterdam";

/** Two complete business days between reference and delivery means the
 * earliest delivery is the third business day after the reference. */
export const REQUIRED_COMPLETE_BUSINESS_DAYS = 2;
const EARLIEST_BUSINESS_DAY_OFFSET = REQUIRED_COMPLETE_BUSINESS_DAYS + 1;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A bare calendar date, "YYYY-MM-DD". Never a timestamp: a delivery date
 * has no time and no zone of its own. */
export type CivilDate = string;

const CIVIL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: DELIVERY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar date an instant falls on *in Amsterdam* — the only place a
 * time zone is consulted at all. */
export function toDeliveryZoneCivilDate(instant: Date): CivilDate {
  const parts = CIVIL_DATE_FORMATTER.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function splitCivilDate(date: CivilDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

/** True only for a real calendar date — rejects e.g. 2026-02-30, which
 * `Date` would otherwise silently roll over into March. */
export function isValidCivilDate(raw: string): raw is CivilDate {
  if (!ISO_DATE_RE.test(raw)) return false;
  const { year, month, day } = splitCivilDate(raw);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return toIsoFromUtcDate(roundTrip) === raw;
}

function toIsoFromUtcDate(date: Date): CivilDate {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Calendar-day arithmetic. `Date.UTC` normalises overflow across month,
 * year and leap-year boundaries for us, with no DST to interfere. */
function addCalendarDays(date: CivilDate, days: number): CivilDate {
  const { year, month, day } = splitCivilDate(date);
  return toIsoFromUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

/** 0 = Sunday … 6 = Saturday, for the civil date itself. */
function civilWeekday(date: CivilDate): number {
  const { year, month, day } = splitCivilDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Monday–Friday only. Saturday and Sunday are never delivery days and never
 * count toward the lead time. */
export function isDeliveryBusinessDay(date: CivilDate): boolean {
  const weekday = civilWeekday(date);
  return weekday >= 1 && weekday <= 5;
}

/**
 * Advances `count` business days past `date`, skipping weekends.
 *
 * The reference date itself is never counted, and a weekend reference simply
 * contributes nothing: counting starts at the next business day. So a
 * Saturday reference and a Sunday reference both reach the same answer as
 * each other, three business days into the following week.
 */
export function addDeliveryBusinessDays(date: CivilDate, count: number): CivilDate {
  let cursor = date;
  let counted = 0;
  while (counted < count) {
    cursor = addCalendarDays(cursor, 1);
    if (isDeliveryBusinessDay(cursor)) counted++;
  }
  return cursor;
}

/**
 * The earliest date a customer may request.
 *
 * The reference is the later of the Order's own date and today, both read as
 * Amsterdam civil dates. In practice today always wins — an Order cannot be
 * created in the future — but the rule is implemented as stated rather than
 * simplified to "today", so a caller passing a deliberately later reference
 * (a future-dated Order, a backfill) still gets a conservative answer.
 */
export function getEarliestRequestedDeliveryDate(input: { orderCreatedAt: Date; now: Date }): CivilDate {
  const orderDate = toDeliveryZoneCivilDate(input.orderCreatedAt);
  const today = toDeliveryZoneCivilDate(input.now);
  // ISO dates compare correctly as plain strings.
  const reference = orderDate > today ? orderDate : today;
  return addDeliveryBusinessDays(reference, EARLIEST_BUSINESS_DAY_OFFSET);
}

const DUTCH_DATE_FORMATTER = new Intl.DateTimeFormat("nl-NL", {
  // The civil date is rendered as-is: formatting in UTC keeps "2026-09-16"
  // reading as 16 September, instead of an offset nudging it to the 15th.
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** "woensdag 16 september 2026" — for customer-facing copy. */
export function formatCivilDateDutch(date: CivilDate): string {
  const { year, month, day } = splitCivilDate(date);
  return DUTCH_DATE_FORMATTER.format(new Date(Date.UTC(year, month - 1, day)));
}

export type RequestedDeliveryDateRejection =
  | "MISSING"
  | "INVALID_FORMAT"
  | "WEEKEND"
  | "TOO_EARLY";

export type RequestedDeliveryDateValidation =
  | { ok: true; date: CivilDate; earliest: CivilDate }
  | { ok: false; reason: RequestedDeliveryDateRejection; message: string; earliest: CivilDate };

/**
 * Server-authoritative validation. The browser's `min` attribute and any
 * weekend-disabling in the picker are UX conveniences only — every rule is
 * re-decided here, because a customer's POST can carry any value at all.
 *
 * A past date needs no separate branch: the earliest allowed date is always
 * at least three business days ahead, so anything in the past is rejected as
 * TOO_EARLY, with a message that names the real earliest date rather than
 * just saying "not in the past".
 */
export function validateRequestedDeliveryDate(input: {
  raw: string | null | undefined;
  orderCreatedAt: Date;
  now: Date;
}): RequestedDeliveryDateValidation {
  const earliest = getEarliestRequestedDeliveryDate({ orderCreatedAt: input.orderCreatedAt, now: input.now });

  const trimmed = (input.raw ?? "").trim();
  if (trimmed === "") {
    return { ok: false, reason: "MISSING", message: "Kies een gewenste leverdatum.", earliest };
  }
  if (!isValidCivilDate(trimmed)) {
    return { ok: false, reason: "INVALID_FORMAT", message: "Ongeldige datum.", earliest };
  }
  if (!isDeliveryBusinessDay(trimmed)) {
    return {
      ok: false,
      reason: "WEEKEND",
      message: "Wij leveren niet op zaterdag en zondag. Kies een werkdag.",
      earliest,
    };
  }
  if (trimmed < earliest) {
    return {
      ok: false,
      reason: "TOO_EARLY",
      message: `Deze datum is te vroeg. De eerst mogelijke leverdatum is ${formatCivilDateDutch(earliest)}.`,
      earliest,
    };
  }
  return { ok: true, date: trimmed, earliest };
}

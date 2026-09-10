import { describe, expect, it } from "vitest";
import {
  isDeliveryBusinessDay,
  addDeliveryBusinessDays,
  getEarliestRequestedDeliveryDate,
  validateRequestedDeliveryDate,
  toDeliveryZoneCivilDate,
  formatCivilDateDutch,
  isValidCivilDate,
} from "@/modules/delivery/delivery-lead-time";

// Phase 6P — every case uses a fixed instant so the whole matrix is
// deterministic regardless of the machine's own clock or zone. Instants are
// chosen at midday UTC unless a case is specifically about a zone boundary.
//
// Reference week used throughout: 2026-09-14 is a Monday.
//   Mon 14, Tue 15, Wed 16, Thu 17, Fri 18, Sat 19, Sun 20, Mon 21, Tue 22, Wed 23
const MON = "2026-09-14";
const TUE = "2026-09-15";
const WED = "2026-09-16";
const THU = "2026-09-17";
const FRI = "2026-09-18";
const SAT = "2026-09-19";
const SUN = "2026-09-20";

/** Midday Amsterdam, expressed as an instant, for a given civil date. */
function at(civilDate: string): Date {
  return new Date(`${civilDate}T10:00:00Z`);
}

/** An Order created long before any reference date, so `now` always wins. */
const OLD_ORDER = new Date("2026-01-05T09:00:00Z");

function earliestFrom(civilDate: string): string {
  return getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: at(civilDate) });
}

describe("isDeliveryBusinessDay", () => {
  it("Monday through Friday are business days", () => {
    for (const d of [MON, TUE, WED, THU, FRI]) expect(isDeliveryBusinessDay(d)).toBe(true);
  });

  it("Saturday and Sunday are never business days", () => {
    expect(isDeliveryBusinessDay(SAT)).toBe(false);
    expect(isDeliveryBusinessDay(SUN)).toBe(false);
  });
});

// The heart of the policy: two COMPLETE business days between reference and
// delivery, so the earliest date is the third business day after it.
describe("getEarliestRequestedDeliveryDate — Fons's seven cases", () => {
  it("Monday -> Thursday (Tue + Wed are the two complete business days)", () => {
    expect(earliestFrom(MON)).toBe(THU);
  });

  it("Tuesday -> Friday (Wed + Thu)", () => {
    expect(earliestFrom(TUE)).toBe(FRI);
  });

  it("Wednesday -> Monday (Thu + Fri, weekend skipped)", () => {
    expect(earliestFrom(WED)).toBe("2026-09-21");
  });

  it("Thursday -> Tuesday (Fri + Mon, weekend skipped)", () => {
    expect(earliestFrom(THU)).toBe("2026-09-22");
  });

  it("Friday -> Wednesday (Mon + Tue, weekend skipped)", () => {
    expect(earliestFrom(FRI)).toBe("2026-09-23");
  });

  it("Saturday -> Wednesday (weekend does not count at all)", () => {
    expect(earliestFrom(SAT)).toBe("2026-09-23");
  });

  it("Sunday -> Wednesday (same as Saturday — neither weekend day counts)", () => {
    expect(earliestFrom(SUN)).toBe("2026-09-23");
  });

  it("a Saturday and a Sunday reference reach the identical answer", () => {
    expect(earliestFrom(SAT)).toBe(earliestFrom(SUN));
  });

  it("is never merely reference + 3 calendar days when a weekend intervenes", () => {
    // Friday + 3 calendar days would be Monday; the policy says Wednesday.
    expect(earliestFrom(FRI)).not.toBe("2026-09-21");
    expect(earliestFrom(FRI)).toBe("2026-09-23");
  });

  it("the earliest date is itself always a business day", () => {
    for (const d of [MON, TUE, WED, THU, FRI, SAT, SUN]) {
      expect(isDeliveryBusinessDay(earliestFrom(d))).toBe(true);
    }
  });
});

describe("addDeliveryBusinessDays", () => {
  it("counts only weekdays and never the reference day itself", () => {
    expect(addDeliveryBusinessDays(MON, 1)).toBe(TUE);
    expect(addDeliveryBusinessDays(MON, 2)).toBe(WED);
    expect(addDeliveryBusinessDays(MON, 3)).toBe(THU);
  });

  it("steps over a weekend without consuming it", () => {
    expect(addDeliveryBusinessDays(FRI, 1)).toBe("2026-09-21");
    expect(addDeliveryBusinessDays(SAT, 1)).toBe("2026-09-21");
    expect(addDeliveryBusinessDays(SUN, 1)).toBe("2026-09-21");
  });
});

describe("calendar boundaries", () => {
  it("crosses a month boundary", () => {
    // Wed 2026-09-30 -> Thu 1 Oct(1), Fri 2(2), Mon 5(3)
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: at("2026-09-30") })).toBe("2026-10-05");
  });

  it("crosses a year boundary", () => {
    // Wed 2026-12-30 -> Thu 31(1), Fri 1 Jan(2), Mon 4(3)
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: at("2026-12-30") })).toBe("2027-01-04");
  });

  it("handles a leap-year February correctly", () => {
    // 2028 is a leap year: Mon 2028-02-28 -> Tue 29(1), Wed 1 Mar(2), Thu 2(3)
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: at("2028-02-28") })).toBe("2028-03-02");
    expect(isValidCivilDate("2028-02-29")).toBe(true);
    expect(isValidCivilDate("2027-02-29")).toBe(false);
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    expect(isValidCivilDate("2026-02-30")).toBe(false);
    expect(isValidCivilDate("2026-13-01")).toBe(false);
    expect(isValidCivilDate("2026-9-1")).toBe(false);
  });
});

// The zone rules are the reason this module exists: a delivery date is a
// Dutch calendar date, not the server's or the browser's.
describe("Europe/Amsterdam boundaries", () => {
  it("an instant just before Amsterdam midnight still belongs to the previous day", () => {
    // 21:59 UTC on 14 Sep = 23:59 CEST on 14 Sep -> still Monday.
    expect(toDeliveryZoneCivilDate(new Date("2026-09-14T21:59:00Z"))).toBe(MON);
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: new Date("2026-09-14T21:59:00Z") })).toBe(THU);
  });

  it("an instant just after Amsterdam midnight has already rolled to the next day", () => {
    // 22:01 UTC on 14 Sep = 00:01 CEST on 15 Sep -> already Tuesday.
    expect(toDeliveryZoneCivilDate(new Date("2026-09-14T22:01:00Z"))).toBe(TUE);
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: new Date("2026-09-14T22:01:00Z") })).toBe(FRI);
  });

  it("summer time (CEST, UTC+2) resolves the civil date correctly", () => {
    expect(toDeliveryZoneCivilDate(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02");
  });

  it("winter time (CET, UTC+1) resolves the civil date correctly", () => {
    expect(toDeliveryZoneCivilDate(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-16");
  });

  it("DST start weekend does not distort the count (clocks forward 2026-03-29)", () => {
    // Fri 2026-03-27 -> Mon 30(1), Tue 31(2), Wed 1 Apr(3) — the lost hour
    // cannot shift a calendar-day count.
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: at("2026-03-27") })).toBe("2026-04-01");
  });

  it("DST end weekend does not distort the count (clocks back 2026-10-25)", () => {
    // Fri 2026-10-23 -> Mon 26(1), Tue 27(2), Wed 28(3)
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: at("2026-10-23") })).toBe("2026-10-28");
  });
});

describe("reference date selection", () => {
  it("a historical Order uses today as the reference, not the Order date", () => {
    // Order created in January, customer submits on the Wednesday.
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: OLD_ORDER, now: at(WED) })).toBe("2026-09-21");
  });

  it("an Order dated later than today wins, keeping the answer conservative", () => {
    expect(getEarliestRequestedDeliveryDate({ orderCreatedAt: at(FRI), now: at(MON) })).toBe("2026-09-23");
  });
});

describe("validateRequestedDeliveryDate", () => {
  const onMonday = (raw: string | null | undefined) =>
    validateRequestedDeliveryDate({ raw, orderCreatedAt: OLD_ORDER, now: at(MON) });
  const onFriday = (raw: string) =>
    validateRequestedDeliveryDate({ raw, orderCreatedAt: OLD_ORDER, now: at(FRI) });

  it("rejects a missing date", () => {
    expect(onMonday(undefined).ok).toBe(false);
    expect(onMonday("").ok).toBe(false);
    expect(onMonday("   ")).toMatchObject({ ok: false, reason: "MISSING" });
  });

  it("rejects an invalid ISO date", () => {
    expect(onMonday("16-09-2026")).toMatchObject({ ok: false, reason: "INVALID_FORMAT" });
    expect(onMonday("2026-02-30")).toMatchObject({ ok: false, reason: "INVALID_FORMAT" });
  });

  it("rejects Saturday with the weekend message", () => {
    const result = onMonday(SAT);
    expect(result).toMatchObject({ ok: false, reason: "WEEKEND" });
    expect(result.ok === false && result.message).toBe("Wij leveren niet op zaterdag en zondag. Kies een werkdag.");
  });

  it("rejects Sunday with the weekend message", () => {
    expect(onMonday(SUN)).toMatchObject({ ok: false, reason: "WEEKEND" });
  });

  it("Monday reference: rejects the first and second business day, accepts the third", () => {
    expect(onMonday(TUE)).toMatchObject({ ok: false, reason: "TOO_EARLY" });
    expect(onMonday(WED)).toMatchObject({ ok: false, reason: "TOO_EARLY" });
    expect(onMonday(THU)).toMatchObject({ ok: true, date: THU });
  });

  it("Monday reference: accepts a later weekday too", () => {
    expect(onMonday(FRI)).toMatchObject({ ok: true, date: FRI });
    expect(onMonday("2026-09-21")).toMatchObject({ ok: true });
  });

  it("Friday reference: rejects Monday and Tuesday, accepts Wednesday", () => {
    expect(onFriday("2026-09-21")).toMatchObject({ ok: false, reason: "TOO_EARLY" });
    expect(onFriday("2026-09-22")).toMatchObject({ ok: false, reason: "TOO_EARLY" });
    expect(onFriday("2026-09-23")).toMatchObject({ ok: true, date: "2026-09-23" });
  });

  it("rejects a date in the past as TOO_EARLY, naming the real earliest date", () => {
    const result = onMonday("2026-09-07");
    expect(result).toMatchObject({ ok: false, reason: "TOO_EARLY" });
    expect(result.ok === false && result.message).toContain("donderdag 17 september 2026");
  });

  it("the too-early message names the earliest date in Dutch", () => {
    const result = onFriday("2026-09-21");
    expect(result.ok === false && result.message).toBe(
      "Deze datum is te vroeg. De eerst mogelijke leverdatum is woensdag 23 september 2026.",
    );
  });

  it("never silently changes the submitted date — a valid date is returned exactly as given", () => {
    const result = onMonday(` ${THU} `);
    expect(result).toMatchObject({ ok: true, date: THU });
  });

  it("always reports the earliest date alongside the outcome", () => {
    expect(onMonday(TUE).earliest).toBe(THU);
    expect(onMonday(THU).earliest).toBe(THU);
  });
});

describe("formatCivilDateDutch", () => {
  it("renders the civil date itself, with no zone shifting it a day", () => {
    expect(formatCivilDateDutch("2026-09-16")).toBe("woensdag 16 september 2026");
    expect(formatCivilDateDutch("2026-01-01")).toBe("donderdag 1 januari 2026");
  });
});

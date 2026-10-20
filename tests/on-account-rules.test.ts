import { describe, expect, it } from "vitest";
import {
  computeDueAt,
  DEFAULT_TERM_DAYS,
  InvalidTermDaysError,
  invoiceMessage,
  parseTermDays,
  resolveCustomerCredit,
  sameInstant,
} from "@/modules/on-account/rules";
import { assertTransition, canTransition, InvalidOnAccountTransitionError, nextAttemptDelayMs } from "@/modules/on-account/state-machine";

describe("on-account customer credit rules", () => {
  it("credit_allowed must be exactly true", () => {
    expect(resolveCustomerCredit(null, "30")).toEqual({ allowed: false, termDays: null });
    expect(resolveCustomerCredit("false", "30")).toEqual({ allowed: false, termDays: null });
    expect(resolveCustomerCredit("TRUE", "30")).toEqual({ allowed: false, termDays: null });
    expect(resolveCustomerCredit("1", null)).toEqual({ allowed: false, termDays: null });
  });
  it("empty term -> 30, set term -> that value (14/30/45/60)", () => {
    expect(resolveCustomerCredit("true", null)).toEqual({ allowed: true, termDays: DEFAULT_TERM_DAYS, termIsDefault: true });
    expect(resolveCustomerCredit("true", "")).toEqual({ allowed: true, termDays: 30, termIsDefault: true });
    for (const d of [14, 30, 45, 60]) expect(resolveCustomerCredit("true", String(d))).toEqual({ allowed: true, termDays: d, termIsDefault: false });
  });
  it("an invalid stored term is an error, never silently 30", () => {
    for (const raw of ["dertig", "0", "-5", "12.5", "400"]) expect(() => parseTermDays(raw)).toThrow(InvalidTermDaysError);
    expect(() => resolveCustomerCredit("true", "abc")).toThrow(InvalidTermDaysError);
  });
});

describe("computeDueAt — Amsterdam calendar date + N days at 23:59:59 local", () => {
  it("the agreed example: delivered 20-10-2026, 30 days -> 19-11-2026 (CET)", () => {
    expect(computeDueAt(new Date("2026-10-20T10:00:00Z"), 30).toISOString()).toBe("2026-11-19T22:59:59.000Z");
  });
  it("uses the Amsterdam calendar date, not the UTC one", () => {
    // 23:30 UTC on 19-10 is already 20-10 in Amsterdam (CEST, +2)
    expect(computeDueAt(new Date("2026-10-19T23:30:00Z"), 30).toISOString()).toBe("2026-11-19T22:59:59.000Z");
    // 21:30 UTC on 19-10 is still 19-10 in Amsterdam
    expect(computeDueAt(new Date("2026-10-19T21:30:00Z"), 30).toISOString()).toBe("2026-11-18T22:59:59.000Z");
  });
  it("is DST-correct in both directions", () => {
    // summer due date (CEST, +2)
    expect(computeDueAt(new Date("2027-03-20T10:00:00Z"), 14).toISOString()).toBe("2027-04-03T21:59:59.000Z");
    // due on the day DST ends (25-10-2026: 23:59:59 is CET, +1)
    expect(computeDueAt(new Date("2026-10-11T10:00:00Z"), 14).toISOString()).toBe("2026-10-25T22:59:59.000Z");
    // due on the day DST starts (28-03-2027: 23:59:59 is CEST, +2)
    expect(computeDueAt(new Date("2027-03-14T10:00:00Z"), 14).toISOString()).toBe("2027-03-28T21:59:59.000Z");
    // delivered across a DST change, 45 and 60 days
    expect(computeDueAt(new Date("2026-10-20T10:00:00Z"), 45).toISOString()).toBe("2026-12-04T22:59:59.000Z");
    expect(computeDueAt(new Date("2026-10-20T10:00:00Z"), 60).toISOString()).toBe("2026-12-19T22:59:59.000Z");
  });
  it("rejects a nonsense term", () => {
    expect(() => computeDueAt(new Date(), 0)).toThrow(InvalidTermDaysError);
    expect(() => computeDueAt(new Date(), 1.5)).toThrow(InvalidTermDaysError);
  });
  it("sameInstant compares at second precision", () => {
    expect(sameInstant("2026-11-19T22:59:59Z", new Date("2026-11-19T22:59:59.000Z"))).toBe(true);
    expect(sameInstant("2026-11-19T22:59:58Z", new Date("2026-11-19T22:59:59.000Z"))).toBe(false);
    expect(sameInstant(null, new Date())).toBe(false);
  });
  it("invoice message says when the term started and the due date", () => {
    const m = invoiceMessage({ termDays: 30, dueAt: new Date("2026-11-19T22:59:59Z"), deliveredAt: new Date("2026-10-20T10:00:00Z"), triggerSource: "PICKUP_HANDOVER" });
    expect(m).toContain("30 dagen");
    expect(m).toContain("20-10-2026");
    expect(m).toContain("19-11-2026");
  });
});

describe("on-account state machine", () => {
  it("allows the happy path", () => {
    const path = ["REGISTERED", "WAITING_FOR_DELIVERY", "DELIVERED", "TERMS_SET", "INVOICE_SENDING", "INVOICE_SENT", "PAID"] as const;
    path.slice(1).forEach((to, i) => expect(canTransition(path[i]!, to)).toBe(true));
  });
  it("never lets terminal states move, and never skips straight to INVOICE_SENT", () => {
    expect(canTransition("PAID", "TERMS_SET")).toBe(false);
    expect(canTransition("CANCELLED", "DELIVERED")).toBe(false);
    expect(canTransition("TERMS_SET", "INVOICE_SENT")).toBe(false);
    expect(canTransition("WAITING_FOR_DELIVERY", "TERMS_SET")).toBe(false);
    expect(() => assertTransition("PAID", "INVOICE_SENDING")).toThrow(InvalidOnAccountTransitionError);
  });
  it("backoff grows and is capped", () => {
    expect(nextAttemptDelayMs(0)).toBe(60_000);
    expect(nextAttemptDelayMs(3)).toBe(8 * 60_000);
    expect(nextAttemptDelayMs(30)).toBe(6 * 60 * 60_000);
  });
});

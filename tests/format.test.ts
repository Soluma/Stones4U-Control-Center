import { describe, expect, it } from "vitest";
import { formatDate, formatDateLong, formatDateTime } from "@/lib/format";

// Regression coverage for a real bug found during the Phase 1 production
// readiness review: date/time formatting had no explicit timeZone, so it
// silently followed the server process's local zone (UTC on most Fly.io/
// Docker hosts) instead of Europe/Amsterdam — see
// docs/build/PHASE-1-PRODUCTION-READINESS.md.

describe("date/time formatting", () => {
  it("formats a UTC timestamp in Europe/Amsterdam local time (CET, winter, UTC+1)", () => {
    // 2026-01-15T23:30:00Z is 2026-01-16 00:30 in Amsterdam (CET, UTC+1) —
    // a date that would show the WRONG calendar day if timeZone weren't set.
    const result = formatDateTime("2026-01-15T23:30:00.000Z");
    expect(result).toContain("16");
    expect(result).toContain("jan");
    expect(result).toMatch(/00:30/);
  });

  it("formats a UTC timestamp in Europe/Amsterdam local time (CEST, summer, UTC+2)", () => {
    const result = formatDateTime("2026-06-15T10:00:00.000Z");
    expect(result).toMatch(/12:00/);
  });

  it("never throws and returns a dash for missing input", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
  });
});

// Phase 6D final review — formatDateLong() is used to display the public
// Order success state's chosen delivery date. A bare YYYY-MM-DD date-only
// string parses as UTC midnight; Europe/Amsterdam is always *ahead* of UTC
// (UTC+1 winter / UTC+2 summer, never behind), so formatting that instant
// in Amsterdam local time can only ever move the displayed clock time
// later within the same calendar day — never roll it back to the previous
// day. The two DST-transition dates below are the sharpest possible test
// of that claim (the offset itself changes exactly at 01:00 UTC on each),
// and both still land on the correct day.
describe("formatDateLong — date-only values never shift calendar day", () => {
  it.each([
    ["2026-01-01", "1 januari 2026"],
    ["2026-03-29", "29 maart 2026"], // EU DST spring-forward date
    ["2026-10-25", "25 oktober 2026"], // EU DST fall-back date
    ["2026-12-31", "31 december 2026"],
  ])("%s renders as the exact same calendar date: %s", (iso, expected) => {
    expect(formatDateLong(iso)).toBe(expected);
  });

  it("never throws and returns a dash for missing input", () => {
    expect(formatDateLong(null)).toBe("—");
    expect(formatDateLong(undefined)).toBe("—");
  });
});

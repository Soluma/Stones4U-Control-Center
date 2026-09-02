import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "@/lib/format";

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

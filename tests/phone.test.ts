import { describe, expect, it } from "vitest";
import { normalizeDutchPhone, buildTelHref } from "@/lib/phone";

describe("normalizeDutchPhone", () => {
  it("normalizes every common Dutch dialing format to the same value", () => {
    const expected = "31612345678";
    expect(normalizeDutchPhone("0612345678")).toBe(expected);
    expect(normalizeDutchPhone("06-12345678")).toBe(expected);
    expect(normalizeDutchPhone("+31 6 12345678")).toBe(expected);
    expect(normalizeDutchPhone("0031612345678")).toBe(expected);
    expect(normalizeDutchPhone("31612345678")).toBe(expected);
  });

  it("returns null for empty/missing input", () => {
    expect(normalizeDutchPhone(null)).toBeNull();
    expect(normalizeDutchPhone(undefined)).toBeNull();
    expect(normalizeDutchPhone("")).toBeNull();
  });

  it("returns null for input that isn't plausibly a phone number", () => {
    expect(normalizeDutchPhone("hello world")).toBeNull();
    expect(normalizeDutchPhone("123")).toBeNull();
  });
});

describe("buildTelHref", () => {
  it("builds a tel: href for a Dutch-formatted number, stripped of formatting", () => {
    expect(buildTelHref("06-12345678")).toBe("tel:0612345678");
    expect(buildTelHref("+31 6 12345678")).toBe("tel:+31612345678");
  });

  it("preserves a genuine international number verbatim — never forces a Dutch 31-prefix", () => {
    // A German number: normalizeDutchPhone() would (incorrectly) rewrite
    // this to "3149301234567" (prepending 31) — buildTelHref() must not.
    const german = "+49 30 1234567";
    expect(buildTelHref(german)).toBe("tel:+49301234567");
    expect(buildTelHref(german)).not.toContain("31");
  });

  it("returns null for null/empty/invalid input", () => {
    expect(buildTelHref(null)).toBeNull();
    expect(buildTelHref(undefined)).toBeNull();
    expect(buildTelHref("")).toBeNull();
    expect(buildTelHref("hello world")).toBeNull();
    expect(buildTelHref("123")).toBeNull();
  });

  it("never produces a malformed href for garbage input", () => {
    expect(buildTelHref("tel:javascript:alert(1)")).toBeNull();
    expect(buildTelHref("06 1234 5678 ext 99")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { normalizeDutchPhone } from "@/lib/phone";

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

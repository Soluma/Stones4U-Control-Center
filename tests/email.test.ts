import { describe, expect, it } from "vitest";
import { normalizeEmail } from "@/lib/email";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Klant@Voorbeeld.NL  ")).toBe("klant@voorbeeld.nl");
  });

  it("returns null for empty/whitespace-only input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it("returns null for input that isn't a plausible email address", () => {
    expect(normalizeEmail("niet-een-email")).toBeNull();
    expect(normalizeEmail("missing-domain@")).toBeNull();
    expect(normalizeEmail("@missing-local.nl")).toBeNull();
  });

  it("does not strip a +alias — a real, distinct mailbox alias, not assumed equivalent to the base address", () => {
    expect(normalizeEmail("klant+order123@voorbeeld.nl")).toBe("klant+order123@voorbeeld.nl");
  });

  it("two differently-cased inputs for the same address normalize identically", () => {
    expect(normalizeEmail("Klant@Voorbeeld.nl")).toBe(normalizeEmail("klant@voorbeeld.NL"));
  });
});

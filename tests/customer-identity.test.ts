import { describe, expect, it } from "vitest";
import {
  effectiveCustomerType,
  customerDisplayName,
  customerSecondaryName,
  shopifyCustomerDisplayName,
  shopifyCustomerSecondaryName,
} from "@/modules/crm/customer-identity";

describe("effectiveCustomerType — truth table (ADR-011 §1)", () => {
  it("override wins over companyName, both directions", () => {
    expect(effectiveCustomerType({ companyName: "Jansen Tuinen BV", customerTypeOverride: "INDIVIDUAL" })).toBe("INDIVIDUAL");
    expect(effectiveCustomerType({ companyName: null, customerTypeOverride: "ORGANIZATION" })).toBe("ORGANIZATION");
  });

  it("derives ORGANIZATION when companyName is non-empty and no override", () => {
    expect(effectiveCustomerType({ companyName: "Jansen Tuinen BV", customerTypeOverride: null })).toBe("ORGANIZATION");
  });

  it("derives INDIVIDUAL when companyName is null and no override", () => {
    expect(effectiveCustomerType({ companyName: null, customerTypeOverride: null })).toBe("INDIVIDUAL");
  });

  it("treats a whitespace-only companyName as not filled", () => {
    expect(effectiveCustomerType({ companyName: "   ", customerTypeOverride: null })).toBe("INDIVIDUAL");
  });

  it("treats an empty-string companyName as not filled", () => {
    expect(effectiveCustomerType({ companyName: "", customerTypeOverride: null })).toBe("INDIVIDUAL");
  });
});

describe("customerDisplayName", () => {
  it("shows companyName for a derived organization", () => {
    expect(
      customerDisplayName({ displayName: "Jan Jansen", companyName: "Jansen Tuinen BV", customerTypeOverride: null }),
    ).toBe("Jansen Tuinen BV");
  });

  it("shows displayName for a derived individual", () => {
    expect(customerDisplayName({ displayName: "Jan Jansen", companyName: null, customerTypeOverride: null })).toBe("Jan Jansen");
  });

  it("falls back safely to displayName when override=ORGANIZATION but companyName is null (never breaks/empties the UI)", () => {
    expect(
      customerDisplayName({ displayName: "Jan Jansen", companyName: null, customerTypeOverride: "ORGANIZATION" }),
    ).toBe("Jan Jansen");
  });

  it("falls back safely to displayName when override=ORGANIZATION but companyName is whitespace-only", () => {
    expect(
      customerDisplayName({ displayName: "Jan Jansen", companyName: "   ", customerTypeOverride: "ORGANIZATION" }),
    ).toBe("Jan Jansen");
  });

  it("falls back to 'Klant' when both displayName and companyName are missing", () => {
    expect(customerDisplayName({ displayName: null, companyName: null, customerTypeOverride: null })).toBe("Klant");
  });

  it("override=INDIVIDUAL always shows displayName even when companyName is filled", () => {
    expect(
      customerDisplayName({ displayName: "Jan Jansen", companyName: "Jansen Tuinen BV", customerTypeOverride: "INDIVIDUAL" }),
    ).toBe("Jan Jansen");
  });
});

describe("customerSecondaryName — Accounthouder line", () => {
  it("shows the account-holder name for an organization when it differs from the primary name", () => {
    expect(
      customerSecondaryName({ displayName: "Jan Jansen", companyName: "Jansen Tuinen BV", customerTypeOverride: null }),
    ).toBe("Jan Jansen");
  });

  it("returns null for an individual (no secondary line)", () => {
    expect(customerSecondaryName({ displayName: "Jan Jansen", companyName: null, customerTypeOverride: null })).toBeNull();
  });

  it("returns null when the account-holder name equals the primary display name (no duplicate line)", () => {
    expect(
      customerSecondaryName({ displayName: "Jansen Tuinen BV", companyName: "Jansen Tuinen BV", customerTypeOverride: null }),
    ).toBeNull();
  });

  it("returns null when override=ORGANIZATION but companyName is null, since the primary name IS the account-holder name here", () => {
    expect(
      customerSecondaryName({ displayName: "Jan Jansen", companyName: null, customerTypeOverride: "ORGANIZATION" }),
    ).toBeNull();
  });

  it("returns null when there is no displayName to show", () => {
    expect(
      customerSecondaryName({ displayName: null, companyName: "Jansen Tuinen BV", customerTypeOverride: null }),
    ).toBeNull();
  });
});

describe("shopifyCustomerDisplayName / shopifyCustomerSecondaryName — live search results (no local profile yet)", () => {
  it("prefers company over displayName", () => {
    expect(shopifyCustomerDisplayName({ displayName: "Jan Jansen", company: "Jansen Tuinen BV" })).toBe("Jansen Tuinen BV");
  });

  it("falls back to displayName when company is empty", () => {
    expect(shopifyCustomerDisplayName({ displayName: "Jan Jansen", company: null })).toBe("Jan Jansen");
  });

  it("falls back to 'Klant' when both are missing", () => {
    expect(shopifyCustomerDisplayName({ displayName: "", company: null })).toBe("Klant");
  });

  it("secondary name shows the account holder only when company is filled and names differ", () => {
    expect(shopifyCustomerSecondaryName({ displayName: "Jan Jansen", company: "Jansen Tuinen BV" })).toBe("Jan Jansen");
    expect(shopifyCustomerSecondaryName({ displayName: "Jan Jansen", company: null })).toBeNull();
    expect(shopifyCustomerSecondaryName({ displayName: "Jansen Tuinen BV", company: "Jansen Tuinen BV" })).toBeNull();
  });
});

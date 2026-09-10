import { describe, expect, it } from "vitest";
import {
  CUSTOMER_CLASSIFICATION_NAMESPACE,
  CUSTOMER_TYPE_METAFIELD_KEY,
  PAYMENT_POLICY_METAFIELD_KEY,
  customerTypeOrUnknown,
  paymentPolicyOrUnknown,
  readCustomerType,
  readPaymentPolicy,
  unclassifiedCustomer,
} from "@/integrations/shopify/customer-classification";

// Phase 6W — the Customer classification contract.
//
// The exact literals below are not invented: they were read live from the
// development shop's metafieldDefinitions(ownerType: CUSTOMER) on 2026-09-10.
// Note "betaling vooraf" — NOT "vooraf". Getting that wrong is precisely the
// failure mode build instruction §1 ("DO NOT GUESS") was written to prevent,
// so it is pinned here.

describe("customer classification — the verified Shopify contract", () => {
  it("addresses both metafields by their exact verified namespace and keys", () => {
    expect(CUSTOMER_CLASSIFICATION_NAMESPACE).toBe("custom");
    expect(PAYMENT_POLICY_METAFIELD_KEY).toBe("payment_policy");
    expect(CUSTOMER_TYPE_METAFIELD_KEY).toBe("customer_type");
  });

  it("maps the exact configured payment_policy choices", () => {
    expect(readPaymentPolicy("betaling vooraf")).toEqual({ status: "VALID", value: "PREPAID" });
    expect(readPaymentPolicy("op rekening")).toEqual({ status: "VALID", value: "ON_ACCOUNT" });
  });

  it("maps the exact configured customer_type choices", () => {
    expect(readCustomerType("particulier")).toEqual({ status: "VALID", value: "CONSUMER" });
    expect(readCustomerType("zakelijk")).toEqual({ status: "VALID", value: "BUSINESS" });
  });
});

describe("customer classification — normalization is defined, not guessed", () => {
  it("trims, collapses internal whitespace, and lower-cases — all lossless", () => {
    expect(readPaymentPolicy("  Betaling Vooraf  ")).toEqual({ status: "VALID", value: "PREPAID" });
    expect(readPaymentPolicy("betaling  vooraf")).toEqual({ status: "VALID", value: "PREPAID" });
    expect(readPaymentPolicy("OP REKENING")).toEqual({ status: "VALID", value: "ON_ACCOUNT" });
    expect(readCustomerType("Zakelijk ")).toEqual({ status: "VALID", value: "BUSINESS" });
  });

  it("trailing-space choices are handled — the same shop really does configure them (aanspreekvorm: 'Dhr. ')", () => {
    expect(readCustomerType("particulier ")).toEqual({ status: "VALID", value: "CONSUMER" });
  });

  it("never guesses at a near-miss — no synonyms, no translation, no fuzzy matching", () => {
    for (const raw of ["vooraf", "prepaid", "PREPAID", "vooruitbetaling", "op-rekening", "rekening"]) {
      expect(readPaymentPolicy(raw).status).toBe("INVALID");
    }
    for (const raw of ["business", "consumer", "b2b", "zakelijke klant", "particuliere klant"]) {
      expect(readCustomerType(raw).status).toBe("INVALID");
    }
  });

  it("an INVALID read records only the length of the offending value, never the value itself", () => {
    const result = readPaymentPolicy("geheime waarde");
    expect(result).toEqual({ status: "INVALID", rawLength: 14 });
    expect(JSON.stringify(result)).not.toContain("geheime");
  });
});

describe("customer classification — absence and fail-closed behaviour", () => {
  it("null, undefined, empty and whitespace-only all read as ABSENT, not INVALID", () => {
    for (const raw of [null, undefined, "", "   ", "\t\n"]) {
      expect(readPaymentPolicy(raw).status).toBe("ABSENT");
      expect(readCustomerType(raw).status).toBe("ABSENT");
    }
  });

  it("ABSENT and INVALID both collapse to UNKNOWN — never to PREPAID", () => {
    expect(paymentPolicyOrUnknown(readPaymentPolicy(null))).toBe("UNKNOWN");
    expect(paymentPolicyOrUnknown(readPaymentPolicy("onzin"))).toBe("UNKNOWN");
    expect(customerTypeOrUnknown(readCustomerType(null))).toBe("UNKNOWN");
    expect(customerTypeOrUnknown(readCustomerType("onzin"))).toBe("UNKNOWN");
  });

  it("the fail-closed result is UNKNOWN on BOTH axes and records why", () => {
    expect(unclassifiedCustomer("NO_CUSTOMER")).toEqual({
      paymentPolicy: "UNKNOWN",
      customerType: "UNKNOWN",
      source: "NO_CUSTOMER",
      paymentPolicyStatus: "ABSENT",
      customerTypeStatus: "ABSENT",
    });
    expect(unclassifiedCustomer("UNREADABLE").paymentPolicy).toBe("UNKNOWN");
  });
});

describe("customer classification — the two axes are independent (build instruction §3)", () => {
  it("reading customer_type never produces a payment policy, and vice versa", () => {
    // "zakelijk" is a valid customer_type and an invalid payment_policy;
    // "op rekening" is the reverse. Neither reader leaks into the other.
    expect(readCustomerType("zakelijk")).toEqual({ status: "VALID", value: "BUSINESS" });
    expect(readPaymentPolicy("zakelijk").status).toBe("INVALID");
    expect(readPaymentPolicy("op rekening")).toEqual({ status: "VALID", value: "ON_ACCOUNT" });
    expect(readCustomerType("op rekening").status).toBe("INVALID");
  });

  it("BUSINESS carries no payment implication at all — the reader returns only what was written", () => {
    const business = readCustomerType("zakelijk");
    expect(business).toEqual({ status: "VALID", value: "BUSINESS" });
    // Nothing in the payment axis was established by reading the type axis.
    expect(paymentPolicyOrUnknown(readPaymentPolicy(undefined))).toBe("UNKNOWN");
  });
});

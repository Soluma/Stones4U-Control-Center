import { describe, expect, it } from "vitest";
import {
  CUSTOMER_CLASSIFICATION_NAMESPACE,
  CUSTOMER_TYPE_METAFIELD_KEY,
  DEFAULT_CUSTOMER_TYPE,
  DEFAULT_PAYMENT_POLICY,
  PAYMENT_POLICY_METAFIELD_KEY,
  readCustomerType,
  readPaymentPolicy,
  resolveCustomerType,
  resolvePaymentPolicy,
  unclassifiedCustomer,
} from "@/integrations/shopify/customer-classification";

// Phase 6W established the exact literals, verified live on both shops
// ("betaling vooraf", not "vooraf"). Phase 6AD changed what ABSENT means:
// these metafields are EXCEPTION fields, so an unset value is the ordinary
// Stones4U customer rather than an unclassified one.
//
// The whole risk of that change lives in one distinction: "nobody needed to
// say anything" must never be confused with "we could not find out". Most of
// this file exists to hold that line.

const policy = (raw: string | null | undefined) => resolvePaymentPolicy(readPaymentPolicy(raw));
const type = (raw: string | null | undefined) => resolveCustomerType(readCustomerType(raw));

describe("customer classification — the verified Shopify contract", () => {
  it("addresses both metafields by their exact verified namespace and keys", () => {
    expect(CUSTOMER_CLASSIFICATION_NAMESPACE).toBe("custom");
    expect(PAYMENT_POLICY_METAFIELD_KEY).toBe("payment_policy");
    expect(CUSTOMER_TYPE_METAFIELD_KEY).toBe("customer_type");
  });

  it("maps the exact configured choices", () => {
    expect(readPaymentPolicy("betaling vooraf")).toEqual({ status: "VALID", value: "PREPAID" });
    expect(readPaymentPolicy("op rekening")).toEqual({ status: "VALID", value: "ON_ACCOUNT" });
    expect(readCustomerType("particulier")).toEqual({ status: "VALID", value: "CONSUMER" });
    expect(readCustomerType("zakelijk")).toEqual({ status: "VALID", value: "BUSINESS" });
  });

  it("normalizes only whitespace and case — never guesses at a near-miss", () => {
    expect(policy("  Betaling Vooraf  ").value).toBe("PREPAID");
    expect(type("Zakelijk ").value).toBe("BUSINESS");
    for (const raw of ["vooraf", "prepaid", "op-rekening", "factuur"]) {
      expect(readPaymentPolicy(raw).status).toBe("INVALID");
    }
    for (const raw of ["bedrijf", "business", "b2b", "zakelijke klant"]) {
      expect(readCustomerType(raw).status).toBe("INVALID");
    }
  });
});

describe("Phase 6AD — ABSENT is an intentional business default", () => {
  it("the defaults are the ordinary Stones4U customer", () => {
    expect(DEFAULT_PAYMENT_POLICY).toBe("PREPAID");
    expect(DEFAULT_CUSTOMER_TYPE).toBe("CONSUMER");
  });

  // §16 A
  it("A. both fields absent -> CONSUMER + PREPAID, marked as defaulted", () => {
    for (const raw of [null, undefined, "", "   ", "\t\n"]) {
      expect(policy(raw)).toEqual({ value: "PREPAID", source: "DEFAULT" });
      expect(type(raw)).toEqual({ value: "CONSUMER", source: "DEFAULT" });
    }
  });

  it("a defaulted value is never reported as if somebody had stated it", () => {
    expect(policy(null).source).toBe("DEFAULT");
    expect(policy("betaling vooraf").source).toBe("EXPLICIT");
    // Same resolved value, different provenance — that distinction is the
    // whole point of keeping the source field.
    expect(policy(null).value).toBe(policy("betaling vooraf").value);
    expect(policy(null).source).not.toBe(policy("betaling vooraf").source);
  });

  it("the read state survives the default, so ABSENT stays visible", () => {
    expect(readPaymentPolicy(null).status).toBe("ABSENT");
    expect(readCustomerType(null).status).toBe("ABSENT");
  });
});

describe("Phase 6AD — explicit values always win over the default", () => {
  // §2
  it("an explicit value is never overridden by a fallback", () => {
    expect(policy("op rekening")).toEqual({ value: "ON_ACCOUNT", source: "EXPLICIT" });
    expect(policy("betaling vooraf")).toEqual({ value: "PREPAID", source: "EXPLICIT" });
    expect(type("zakelijk")).toEqual({ value: "BUSINESS", source: "EXPLICIT" });
    expect(type("particulier")).toEqual({ value: "CONSUMER", source: "EXPLICIT" });
  });

  // §16 B/C/D — defaults apply PER FIELD.
  it("B. BUSINESS + payment absent -> BUSINESS + PREPAID", () => {
    expect(type("zakelijk").value).toBe("BUSINESS");
    expect(policy(null).value).toBe("PREPAID");
  });

  it("C. customer type absent + ON_ACCOUNT -> CONSUMER + ON_ACCOUNT", () => {
    expect(type(null).value).toBe("CONSUMER");
    expect(policy("op rekening").value).toBe("ON_ACCOUNT");
  });

  it("D. explicit particulier + betaling vooraf -> CONSUMER + PREPAID, both EXPLICIT", () => {
    expect(type("particulier")).toEqual({ value: "CONSUMER", source: "EXPLICIT" });
    expect(policy("betaling vooraf")).toEqual({ value: "PREPAID", source: "EXPLICIT" });
  });

  it("the two axes stay independent — one field's default never touches the other", () => {
    // "zakelijk" is a valid customer_type and an invalid payment_policy.
    expect(type("zakelijk").value).toBe("BUSINESS");
    expect(policy("zakelijk").value).toBe("UNKNOWN");
    expect(policy("op rekening").value).toBe("ON_ACCOUNT");
    expect(type("op rekening").value).toBe("UNKNOWN");
  });
});

describe("Phase 6AD — INVALID and UNREADABLE must NOT default", () => {
  // §16 E / F — an explicit bad value is not the same as no value.
  it("E. an invalid payment value -> UNKNOWN, never the PREPAID default", () => {
    const result = policy("factuur");
    expect(result).toEqual({ value: "UNKNOWN", source: "FAIL_CLOSED" });
    expect(result.value).not.toBe(DEFAULT_PAYMENT_POLICY);
  });

  it("F. an invalid customer type -> UNKNOWN, never the CONSUMER default", () => {
    const result = type("bedrijf");
    expect(result).toEqual({ value: "UNKNOWN", source: "FAIL_CLOSED" });
    expect(result.value).not.toBe(DEFAULT_CUSTOMER_TYPE);
  });

  it("an INVALID read still records only the offending value's length, never the value", () => {
    const read = readPaymentPolicy("geheime waarde");
    expect(read).toEqual({ status: "INVALID", rawLength: 14 });
    expect(JSON.stringify(read)).not.toContain("geheime");
  });

  // §16 G — the distinction that matters most.
  it("G. an unreadable Shopify response -> UNKNOWN on both axes, NOT the defaults", () => {
    const result = unclassifiedCustomer("UNREADABLE");
    expect(result.paymentPolicy).toBe("UNKNOWN");
    expect(result.customerType).toBe("UNKNOWN");
    expect(result.paymentPolicySource).toBe("FAIL_CLOSED");
    expect(result.customerTypeSource).toBe("FAIL_CLOSED");
    expect(result.paymentPolicyStatus).toBe("UNREADABLE");
    expect(result.customerTypeStatus).toBe("UNREADABLE");
    expect(result.paymentPolicy).not.toBe(DEFAULT_PAYMENT_POLICY);
    expect(result.customerType).not.toBe(DEFAULT_CUSTOMER_TYPE);
  });

  // §16 H / §6 — a guest Order is not a customer with empty metafields.
  it("H. an Order with no customer -> UNKNOWN, NOT the defaults", () => {
    const result = unclassifiedCustomer("NO_CUSTOMER");
    expect(result.paymentPolicy).toBe("UNKNOWN");
    expect(result.customerType).toBe("UNKNOWN");
    expect(result.paymentPolicyStatus).toBe("NO_CUSTOMER");
    expect(result.customerTypeStatus).toBe("NO_CUSTOMER");
    expect(result.paymentPolicySource).toBe("FAIL_CLOSED");
  });

  it("'no customer' and 'a real customer with nothing stored' are structurally distinguishable", () => {
    const guest = unclassifiedCustomer("NO_CUSTOMER");
    const ordinary = policy(null);
    expect(guest.paymentPolicy).toBe("UNKNOWN");
    expect(ordinary.value).toBe("PREPAID");
    // The failure this guards against: a read failure quietly becoming a
    // business default, which would let an unknown customer be treated as
    // having already paid up front.
    expect(guest.paymentPolicy).not.toBe(ordinary.value);
  });
});

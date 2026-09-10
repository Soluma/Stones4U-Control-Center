import { describe, expect, it } from "vitest";
import {
  STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY,
  EXPLICIT_FULFILLMENT_MODES,
  readExplicitFulfillmentMode,
  resolveFulfillmentMode,
  type ExplicitFulfillmentMode,
  type ExplicitFulfillmentModeRead,
} from "@/integrations/shopify/fulfillment-contract";
import { aggregateFulfillmentMode, type FulfillmentMode } from "@/integrations/shopify/fulfillment-mode";

const KEY = STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY;

function attrs(...pairs: [string, string][]) {
  return pairs.map(([key, value]) => ({ key, value }));
}

describe("readExplicitFulfillmentMode — parsing", () => {
  it("the canonical key is the contract's exact lowercase snake_case literal", () => {
    expect(KEY).toBe("stones4u_fulfillment_mode");
  });

  it.each(EXPLICIT_FULFILLMENT_MODES)("reads the canonical value %s", (mode) => {
    expect(readExplicitFulfillmentMode(attrs([KEY, mode]))).toEqual({ status: "VALID", mode });
  });

  it("UNKNOWN is not a writable value — stating it explicitly is invalid, not a mode", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, "UNKNOWN"]))).toEqual({ status: "INVALID" });
  });

  it("a missing key reads as ABSENT", () => {
    expect(readExplicitFulfillmentMode(attrs(["requested_delivery_date", "2026-09-24"]))).toEqual({ status: "ABSENT" });
  });

  it("no customAttributes at all reads as ABSENT", () => {
    expect(readExplicitFulfillmentMode([])).toEqual({ status: "ABSENT" });
  });

  it("an empty value reads as ABSENT — an empty attribute states nothing", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, ""]))).toEqual({ status: "ABSENT" });
  });

  it("a whitespace-only value reads as ABSENT", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, "   "]))).toEqual({ status: "ABSENT" });
  });

  // Normalization is exactly two lossless transformations, defined by the
  // contract: trim + upper-case. Neither can turn one valid value into a
  // different valid value.
  it("tolerates surrounding whitespace (defined normalization, not a guess)", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, " DELIVERY "]))).toEqual({ status: "VALID", mode: "DELIVERY" });
  });

  it("tolerates casing (defined normalization, not a guess)", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, "customer_pickup"]))).toEqual({
      status: "VALID",
      mode: "CUSTOMER_PICKUP",
    });
  });

  it("does NOT coerce a Dutch spelling variant — BEZORGEN is invalid, never DELIVERY", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, "BEZORGEN"]))).toEqual({ status: "INVALID" });
  });

  it("does NOT coerce a near-miss spelling — PICKUP is invalid, never CUSTOMER_PICKUP", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, "PICKUP"]))).toEqual({ status: "INVALID" });
  });

  it("does NOT accept a value with interior text around a valid one", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, "Delivery Mode"]))).toEqual({ status: "INVALID" });
  });

  it("duplicate keys read as DUPLICATE — never resolved by picking one", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, "DELIVERY"], [KEY, "CUSTOMER_PICKUP"]))).toEqual({
      status: "DUPLICATE",
    });
  });

  it("duplicate keys are DUPLICATE even when both values agree", () => {
    expect(readExplicitFulfillmentMode(attrs([KEY, "DELIVERY"], [KEY, "DELIVERY"]))).toEqual({ status: "DUPLICATE" });
  });

  it("key matching is exact and case-sensitive — a differently-cased key is simply not this signal", () => {
    expect(readExplicitFulfillmentMode(attrs(["Stones4U_Fulfillment_Mode", "DELIVERY"]))).toEqual({ status: "ABSENT" });
  });

  it("ignores unrelated customAttributes while reading its own key", () => {
    const read = readExplicitFulfillmentMode(
      attrs(["requested_delivery_date", "2026-09-24"], ["some_other_app_key", "whatever"], [KEY, "RETAIL"]),
    );
    expect(read).toEqual({ status: "VALID", mode: "RETAIL" });
  });
});

const VALID = (mode: ExplicitFulfillmentMode): ExplicitFulfillmentModeRead => ({ status: "VALID", mode });
const ABSENT: ExplicitFulfillmentModeRead = { status: "ABSENT" };

function resolve(explicit: ExplicitFulfillmentModeRead, native: FulfillmentMode) {
  return resolveFulfillmentMode({ explicit, native });
}

describe("resolveFulfillmentMode — explicit signal present", () => {
  it("explicit DELIVERY + native DELIVERY -> DELIVERY, source EXPLICIT, no conflict", () => {
    expect(resolve(VALID("DELIVERY"), "DELIVERY")).toEqual({
      mode: "DELIVERY",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "NONE",
    });
  });

  it("explicit DELIVERY + native UNKNOWN -> DELIVERY (an unknown native does not contradict)", () => {
    expect(resolve(VALID("DELIVERY"), "UNKNOWN")).toEqual({
      mode: "DELIVERY",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "NONE",
    });
  });

  it("explicit DELIVERY + native CUSTOMER_PICKUP -> UNKNOWN with conflict", () => {
    expect(resolve(VALID("DELIVERY"), "CUSTOMER_PICKUP")).toEqual({
      mode: "UNKNOWN",
      source: "NONE",
      conflict: true,
      diagnostic: "EXPLICIT_DELIVERY_CONTRADICTED",
    });
  });

  it("explicit DELIVERY + native RETAIL -> UNKNOWN with conflict", () => {
    expect(resolve(VALID("DELIVERY"), "RETAIL")).toEqual({
      mode: "UNKNOWN",
      source: "NONE",
      conflict: true,
      diagnostic: "EXPLICIT_DELIVERY_CONTRADICTED",
    });
  });

  it("explicit DELIVERY + native NONE -> UNKNOWN with conflict", () => {
    expect(resolve(VALID("DELIVERY"), "NONE")).toEqual({
      mode: "UNKNOWN",
      source: "NONE",
      conflict: true,
      diagnostic: "EXPLICIT_DELIVERY_CONTRADICTED",
    });
  });

  it("explicit DELIVERY + native PICKUP_POINT -> UNKNOWN with conflict", () => {
    expect(resolve(VALID("DELIVERY"), "PICKUP_POINT")).toEqual({
      mode: "UNKNOWN",
      source: "NONE",
      conflict: true,
      diagnostic: "EXPLICIT_DELIVERY_CONTRADICTED",
    });
  });

  // The production migration case: staff marked it Afhalen, Shopify still
  // says SHIPPING because of a typed "Ophalen" shipping line (Phase 6I).
  it("explicit CUSTOMER_PICKUP + native DELIVERY -> CUSTOMER_PICKUP, recorded as an override, not a conflict", () => {
    expect(resolve(VALID("CUSTOMER_PICKUP"), "DELIVERY")).toEqual({
      mode: "CUSTOMER_PICKUP",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "EXPLICIT_OVERRODE_NATIVE",
    });
  });

  it("explicit CUSTOMER_PICKUP + native CUSTOMER_PICKUP -> CUSTOMER_PICKUP, no diagnostic", () => {
    expect(resolve(VALID("CUSTOMER_PICKUP"), "CUSTOMER_PICKUP")).toEqual({
      mode: "CUSTOMER_PICKUP",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "NONE",
    });
  });

  it("explicit PICKUP_POINT + native PICKUP_POINT -> PICKUP_POINT", () => {
    expect(resolve(VALID("PICKUP_POINT"), "PICKUP_POINT")).toEqual({
      mode: "PICKUP_POINT",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "NONE",
    });
  });

  it("explicit RETAIL + native RETAIL -> RETAIL", () => {
    expect(resolve(VALID("RETAIL"), "RETAIL")).toEqual({
      mode: "RETAIL",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "NONE",
    });
  });

  it("explicit NONE + native NONE -> NONE", () => {
    expect(resolve(VALID("NONE"), "NONE")).toEqual({
      mode: "NONE",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "NONE",
    });
  });

  it("two disagreeing non-delivery signals still resolve to the explicit one, recorded", () => {
    expect(resolve(VALID("CUSTOMER_PICKUP"), "RETAIL")).toEqual({
      mode: "CUSTOMER_PICKUP",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "EXPLICIT_OVERRODE_NATIVE",
    });
  });

  it("an explicit non-delivery mode wins over an unknown native without any diagnostic", () => {
    expect(resolve(VALID("RETAIL"), "UNKNOWN")).toEqual({
      mode: "RETAIL",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "NONE",
    });
  });
});

describe("resolveFulfillmentMode — no explicit signal", () => {
  it("native CUSTOMER_PICKUP -> CUSTOMER_PICKUP, source NATIVE (trusted hard negative)", () => {
    expect(resolve(ABSENT, "CUSTOMER_PICKUP")).toEqual({
      mode: "CUSTOMER_PICKUP",
      source: "NATIVE",
      conflict: false,
      diagnostic: "NONE",
    });
  });

  it("native RETAIL -> RETAIL, source NATIVE", () => {
    expect(resolve(ABSENT, "RETAIL")).toEqual({ mode: "RETAIL", source: "NATIVE", conflict: false, diagnostic: "NONE" });
  });

  it("native NONE -> NONE, source NATIVE", () => {
    expect(resolve(ABSENT, "NONE")).toEqual({ mode: "NONE", source: "NATIVE", conflict: false, diagnostic: "NONE" });
  });

  // The central Phase 6I finding: 29 real pickup Orders produced native
  // SHIPPING, 26 of them paid. Bare native DELIVERY must never be actionable.
  it("native DELIVERY -> UNKNOWN — Phase 6I proved SHIPPING is not positive evidence", () => {
    expect(resolve(ABSENT, "DELIVERY")).toEqual({
      mode: "UNKNOWN",
      source: "NONE",
      conflict: false,
      diagnostic: "NATIVE_NOT_TRUSTED",
    });
  });

  it("native PICKUP_POINT -> UNKNOWN — never production-observed, so not trusted either way", () => {
    expect(resolve(ABSENT, "PICKUP_POINT")).toEqual({
      mode: "UNKNOWN",
      source: "NONE",
      conflict: false,
      diagnostic: "NATIVE_NOT_TRUSTED",
    });
  });

  it("native UNKNOWN -> UNKNOWN", () => {
    expect(resolve(ABSENT, "UNKNOWN")).toEqual({ mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NONE" });
  });

  // A mixed-fulfillment Order reaches Layer 2 already aggregated to UNKNOWN
  // (build instruction §7) and must stay safe.
  it("a mixed-fulfillment Order (native already aggregated to UNKNOWN) stays UNKNOWN", () => {
    expect(resolve(ABSENT, "UNKNOWN").mode).toBe("UNKNOWN");
  });
});

describe("resolveFulfillmentMode — untrustworthy explicit signal never becomes DELIVERY", () => {
  const natives: FulfillmentMode[] = ["DELIVERY", "CUSTOMER_PICKUP", "PICKUP_POINT", "RETAIL", "NONE", "UNKNOWN"];

  it.each(natives)("an INVALID explicit value resolves UNKNOWN with native %s", (native) => {
    expect(resolve({ status: "INVALID" }, native)).toEqual({
      mode: "UNKNOWN",
      source: "NONE",
      conflict: true,
      diagnostic: "INVALID_EXPLICIT_VALUE",
    });
  });

  it.each(natives)("a DUPLICATE explicit key resolves UNKNOWN with native %s", (native) => {
    expect(resolve({ status: "DUPLICATE" }, native)).toEqual({
      mode: "UNKNOWN",
      source: "NONE",
      conflict: true,
      diagnostic: "DUPLICATE_EXPLICIT_KEY",
    });
  });

  it("end-to-end: a duplicated key on real attributes never yields DELIVERY", () => {
    const read = readExplicitFulfillmentMode(attrs([KEY, "DELIVERY"], [KEY, "DELIVERY"]));
    expect(resolve(read, "DELIVERY").mode).toBe("UNKNOWN");
  });

  it("end-to-end: an invalid value never yields DELIVERY even when native says DELIVERY", () => {
    const read = readExplicitFulfillmentMode(attrs([KEY, "BEZORGEN"]));
    expect(resolve(read, "DELIVERY").mode).toBe("UNKNOWN");
  });
});

// The full Layer 1 -> Layer 2 chain, starting from raw Shopify values rather
// than from an already-translated FulfillmentMode. This is the regression
// that matters most: SHIPPING and LOCAL both translate to Layer-1 DELIVERY,
// so both must be proven unable to reach an authoritative DELIVERY on their
// own. Phase 6I found 29 real pickup Orders (26 paid) carrying native
// SHIPPING; LOCAL has never been observed in production at all.
describe("Layer 1 -> Layer 2 end to end — no explicit signal", () => {
  function resolveFromRaw(methodTypes: (string | null)[], explicit: ExplicitFulfillmentModeRead = ABSENT) {
    const native = aggregateFulfillmentMode({ methodTypes, hasUnreadFulfillmentOrders: false });
    return { native, resolution: resolveFulfillmentMode({ explicit, native }) };
  }

  it("raw SHIPPING translates to DELIVERY at Layer 1 but resolves UNKNOWN at Layer 2", () => {
    const { native, resolution } = resolveFromRaw(["SHIPPING"]);
    expect(native).toBe("DELIVERY");
    expect(resolution.mode).toBe("UNKNOWN");
    expect(resolution.diagnostic).toBe("NATIVE_NOT_TRUSTED");
  });

  it("raw LOCAL translates to DELIVERY at Layer 1 but also resolves UNKNOWN at Layer 2", () => {
    const { native, resolution } = resolveFromRaw(["LOCAL"]);
    expect(native).toBe("DELIVERY");
    expect(resolution.mode).toBe("UNKNOWN");
    expect(resolution.diagnostic).toBe("NATIVE_NOT_TRUSTED");
  });

  it("a SHIPPING+LOCAL split Order agrees on Layer-1 DELIVERY and still resolves UNKNOWN", () => {
    const { native, resolution } = resolveFromRaw(["SHIPPING", "LOCAL"]);
    expect(native).toBe("DELIVERY");
    expect(resolution.mode).toBe("UNKNOWN");
  });

  it("raw PICK_UP resolves to CUSTOMER_PICKUP via the trusted native path", () => {
    expect(resolveFromRaw(["PICK_UP"]).resolution).toEqual({
      mode: "CUSTOMER_PICKUP",
      source: "NATIVE",
      conflict: false,
      diagnostic: "NONE",
    });
  });

  it("raw RETAIL resolves to RETAIL, raw NONE resolves to NONE", () => {
    expect(resolveFromRaw(["RETAIL"]).resolution.mode).toBe("RETAIL");
    expect(resolveFromRaw(["NONE"]).resolution.mode).toBe("NONE");
  });

  it("a mixed-fulfillment Order (SHIPPING + PICK_UP) never produces a positive DELIVERY", () => {
    const { native, resolution } = resolveFromRaw(["SHIPPING", "PICK_UP"]);
    expect(native).toBe("UNKNOWN");
    expect(resolution.mode).toBe("UNKNOWN");
  });

  // Exhaustive: no raw Shopify value, alone or combined, may yield DELIVERY
  // without an explicit Stones4U signal.
  it("EXHAUSTIVE: no raw methodType (or pair of them) reaches DELIVERY without an explicit signal", () => {
    const raw = ["SHIPPING", "LOCAL", "PICK_UP", "PICKUP_POINT", "RETAIL", "NONE", null, "FUTURE_VALUE"];
    for (const a of raw) {
      expect(resolveFromRaw([a]).resolution.mode).not.toBe("DELIVERY");
      for (const b of raw) {
        expect(resolveFromRaw([a, b]).resolution.mode).not.toBe("DELIVERY");
      }
    }
  });

  it("a truncated connection never reaches DELIVERY either", () => {
    const native = aggregateFulfillmentMode({ methodTypes: ["SHIPPING"], hasUnreadFulfillmentOrders: true });
    expect(resolveFulfillmentMode({ explicit: ABSENT, native }).mode).toBe("UNKNOWN");
  });

  it("the SAME raw SHIPPING Order does reach DELIVERY once an explicit signal states it", () => {
    expect(resolveFromRaw(["SHIPPING"], VALID("DELIVERY")).resolution).toEqual({
      mode: "DELIVERY",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "NONE",
    });
  });
});

describe("resolveFulfillmentMode — safety asymmetry", () => {
  // Positive resolution (may contact a customer) requires stronger evidence
  // than any non-delivery resolution (merely stops automation).
  it("DELIVERY is only ever reached via an explicit signal, never from native alone", () => {
    const natives: FulfillmentMode[] = ["DELIVERY", "CUSTOMER_PICKUP", "PICKUP_POINT", "RETAIL", "NONE", "UNKNOWN"];
    for (const native of natives) {
      expect(resolve(ABSENT, native).mode).not.toBe("DELIVERY");
    }
  });

  it("every non-delivery mode is reachable from a trusted native signal alone", () => {
    expect(resolve(ABSENT, "CUSTOMER_PICKUP").mode).toBe("CUSTOMER_PICKUP");
    expect(resolve(ABSENT, "RETAIL").mode).toBe("RETAIL");
    expect(resolve(ABSENT, "NONE").mode).toBe("NONE");
  });
});

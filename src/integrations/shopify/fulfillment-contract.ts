import type { FulfillmentMode } from "./fulfillment-mode";

// Phase 6K — the Stones4U fulfillment contract: an explicit, Stones4U-owned
// Order-level business signal, plus the Layer-2 authority resolution that
// decides what is trustworthy enough to act on.
//
// WHY THIS EXISTS (Phase 6I production evidence, 400 real Orders):
// Shopify's own DeliveryMethodType is a faithful description of how Shopify
// itself is configured, but it is NOT a faithful description of Stones4U
// business reality. 29 genuinely-collected ("Ophalen magazijn Beringe")
// production Orders produced native SHIPPING, because staff type a free-text
// shipping line instead of using Shopify's native local-pickup mechanism —
// and native SHIPPING is simply Shopify's default for "these line items are
// physical goods". 26 of those 29 were paid. Acting on native SHIPPING would
// therefore have asked 26 customers when we could deliver goods they were
// coming to collect themselves.
//
// TWO LAYERS, deliberately separate:
//   Layer 1 — fulfillment-mode.ts — Shopify semantic TRANSLATION. Unchanged
//             by this phase. `LOCAL -> DELIVERY` remains the correct reading
//             of what Shopify means.
//   Layer 2 — this file — Stones4U AUTHORITY. Decides what may be acted on.
//             It may legitimately answer UNKNOWN for an Order whose Layer-1
//             translation is a confident DELIVERY.
//
// Translation is not authority. Conflating the two is the exact mistake
// Phase 6I caught in production.
//
// Lives in integrations/shopify (not modules/delivery) for the same reason
// fulfillment-mode.ts does: order-for-handoff.ts, an integrations-layer file,
// must return an already-resolved result so no downstream caller re-derives
// these rules, and this repo's module boundary (CLAUDE.md) forbids
// integrations depending on modules.

/** The Shopify Order/DraftOrder customAttribute key carrying the explicit
 * signal. The single source of this literal — never inline it elsewhere.
 *
 * Carrier chosen in Phase 6J: a customAttribute, not a metafield. Draft ->
 * Order propagation of customAttributes is already proven in this system
 * (`requested_delivery_date`), whereas Shopify's draft-order metafield copy
 * requires matching metafield definitions on both owner types and is
 * undocumented for API-created drafts.
 *
 * Key matching is EXACT (case-sensitive). The contract specifies this exact
 * lowercase snake_case key; a differently-cased key is a different key and is
 * simply not this signal. */
export const STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY = "stones4u_fulfillment_mode";

/** The values a writer may legitimately set. Deliberately excludes UNKNOWN:
 * UNKNOWN is a *read* outcome meaning "we could not establish this", never
 * something a writer states about an Order. */
export type ExplicitFulfillmentMode = "DELIVERY" | "CUSTOMER_PICKUP" | "PICKUP_POINT" | "RETAIL" | "NONE";

/** Canonical, exact spellings. A strict future writer must emit one of these
 * verbatim — see the normalization note on readExplicitFulfillmentMode() for
 * why reads are more forgiving than writes are allowed to be. */
export const EXPLICIT_FULFILLMENT_MODES = [
  "DELIVERY",
  "CUSTOMER_PICKUP",
  "PICKUP_POINT",
  "RETAIL",
  "NONE",
] as const satisfies readonly ExplicitFulfillmentMode[];

const EXPLICIT_FULFILLMENT_MODE_SET: ReadonlySet<string> = new Set(EXPLICIT_FULFILLMENT_MODES);

/**
 * Outcome of reading the explicit signal off an Order's customAttributes.
 *
 * `INVALID` and `DUPLICATE` are structurally distinct from `ABSENT` on
 * purpose: absent means nobody has stated a mode yet (ordinary, expected for
 * every historical Order), while invalid/duplicate mean somebody stated
 * something we cannot trust (a data-quality fault a human should fix).
 */
export type ExplicitFulfillmentModeRead =
  | { status: "ABSENT" }
  | { status: "VALID"; mode: ExplicitFulfillmentMode }
  | { status: "INVALID" }
  | { status: "DUPLICATE" };

/**
 * Reads the explicit signal from an Order's (or Draft Order's)
 * customAttributes.
 *
 * **Normalization is explicitly defined, not guessed** (Phase 6K build
 * instruction §10). Exactly two transformations are applied to the value:
 * surrounding whitespace is trimmed, and the result is upper-cased. Both are
 * lossless and cannot turn one valid value into a different valid value, so
 * `"DELIVERY "` and `"delivery"` both read as `DELIVERY`. Nothing else is
 * accepted: no synonyms, no fuzzy matching, no translation. `"BEZORGEN"`,
 * `"PICKUP"` and `"Delivery Mode"` are all `INVALID`, never coerced —
 * silently guessing at a spelling variant is exactly how a pickup Order would
 * become a delivery Order.
 *
 * A value that is empty (or whitespace-only) reads as `ABSENT` rather than
 * `INVALID`: an empty attribute states nothing, so it is treated as nothing
 * stated, and trusted native negatives may still apply.
 *
 * Duplicate keys are never resolved by picking one — see `DUPLICATE`.
 */
export function readExplicitFulfillmentMode(
  customAttributes: readonly { key: string; value: string }[],
): ExplicitFulfillmentModeRead {
  const matches = customAttributes.filter((a) => a.key === STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY);

  if (matches.length === 0) return { status: "ABSENT" };
  if (matches.length > 1) return { status: "DUPLICATE" };

  const normalized = (matches[0]?.value ?? "").trim().toUpperCase();
  if (normalized === "") return { status: "ABSENT" };
  if (!EXPLICIT_FULFILLMENT_MODE_SET.has(normalized)) return { status: "INVALID" };

  return { status: "VALID", mode: normalized as ExplicitFulfillmentMode };
}

/** Which signal actually determined the resolved mode. `NONE` means neither
 * signal was trustworthy enough and the result is `UNKNOWN`. */
export type FulfillmentModeSource = "EXPLICIT" | "NATIVE" | "NONE";

/**
 * Machine-readable reason for the resolution — the instrumentation surface.
 * Fons' Phase 6K decision 6 is "first instrument/observe safely; activation
 * criteria come later", and these values are what makes that observation
 * possible without anyone having to re-derive intent from raw signals.
 *
 * - `NONE` — signals agreed, or only one was present.
 * - `EXPLICIT_OVERRODE_NATIVE` — an explicit NON-delivery mode won over a
 *   disagreeing native mode. Benign and expected while the typed-"Ophalen"
 *   practice is migrated; the observable count of these is the migration
 *   progress metric.
 * - `EXPLICIT_DELIVERY_CONTRADICTED` — explicit said DELIVERY but a native
 *   non-delivery mode disagreed. Unsafe direction: resolves to UNKNOWN.
 * - `INVALID_EXPLICIT_VALUE` / `DUPLICATE_EXPLICIT_KEY` — the explicit signal
 *   exists but cannot be trusted; a human should correct the Order.
 * - `NATIVE_NOT_TRUSTED` — no explicit signal, and the native mode is one we
 *   refuse to act on positively (DELIVERY, or the never-production-observed
 *   PICKUP_POINT).
 */
export type FulfillmentResolutionDiagnostic =
  | "NONE"
  | "EXPLICIT_OVERRODE_NATIVE"
  | "EXPLICIT_DELIVERY_CONTRADICTED"
  | "INVALID_EXPLICIT_VALUE"
  | "DUPLICATE_EXPLICIT_KEY"
  | "NATIVE_NOT_TRUSTED";

export type FulfillmentModeResolution = {
  mode: FulfillmentMode;
  source: FulfillmentModeSource;
  /** True only for a genuine contradiction that blocked a resolution — not
   * for the benign migration-era mismatch (`EXPLICIT_OVERRODE_NATIVE`). */
  conflict: boolean;
  diagnostic: FulfillmentResolutionDiagnostic;
};

/** Native modes trustworthy enough to stand alone, from Phase 6I production
 * evidence: CUSTOMER_PICKUP (14 Orders), RETAIL (15), NONE (32) — zero false
 * positives observed for any of them. All three are non-delivery, so acting
 * on them can only ever *stop* automation, never start customer contact.
 *
 * Deliberately excluded: DELIVERY (native SHIPPING — 29 known-wrong Orders in
 * production) and PICKUP_POINT (never observed in production at all, so there
 * is no evidence either way and no cost to waiting). */
const NATIVE_TRUSTED_NEGATIVES: ReadonlySet<FulfillmentMode> = new Set<FulfillmentMode>([
  "CUSTOMER_PICKUP",
  "RETAIL",
  "NONE",
]);

/**
 * Layer 2 — resolves the authoritative Stones4U fulfillment mode.
 *
 * **The asymmetry is the point** (build instruction §6). Resolving to
 * DELIVERY requires strictly stronger evidence than resolving to any
 * non-delivery mode, because the consequences are not symmetric:
 *
 * - a wrong DELIVERY may contact a customer incorrectly — irreversible, and
 *   visible to the customer;
 * - a wrong non-delivery (or UNKNOWN) merely stops automation, leaving staff
 *   to act manually — cheap and recoverable.
 *
 * So an explicit non-delivery mode always wins, while an explicit DELIVERY
 * must not be contradicted by any trustworthy native negative, and a bare
 * native DELIVERY is never enough on its own.
 *
 * `native` MUST already be the conservatively aggregated result of
 * `aggregateFulfillmentMode()` over every FulfillmentOrder — a mixed-
 * fulfillment Order arrives here as `UNKNOWN` and must never be un-mixed
 * afterwards (build instruction §7).
 *
 * Pure: no Shopify call, no database, no side effects.
 */
export function resolveFulfillmentMode(input: {
  explicit: ExplicitFulfillmentModeRead;
  native: FulfillmentMode;
}): FulfillmentModeResolution {
  const { explicit, native } = input;

  // A stated-but-untrustworthy explicit signal is a data fault. It resolves
  // to UNKNOWN rather than falling back to the native mode: UNKNOWN routes to
  // "insufficient classification", which is precisely the "a human should
  // look at this" outcome a corrupted value deserves.
  if (explicit.status === "DUPLICATE") {
    return { mode: "UNKNOWN", source: "NONE", conflict: true, diagnostic: "DUPLICATE_EXPLICIT_KEY" };
  }
  if (explicit.status === "INVALID") {
    return { mode: "UNKNOWN", source: "NONE", conflict: true, diagnostic: "INVALID_EXPLICIT_VALUE" };
  }

  if (explicit.status === "VALID") {
    if (explicit.mode === "DELIVERY") {
      // The one direction that can start customer contact, so it is the one
      // direction that requires the native signal not to disagree.
      if (native !== "DELIVERY" && native !== "UNKNOWN") {
        return { mode: "UNKNOWN", source: "NONE", conflict: true, diagnostic: "EXPLICIT_DELIVERY_CONTRADICTED" };
      }
      return { mode: "DELIVERY", source: "EXPLICIT", conflict: false, diagnostic: "NONE" };
    }

    // Explicit non-delivery always wins. Native SHIPPING disagreeing here is
    // the expected, already-explained migration case (typed "Ophalen" lines),
    // and is recorded rather than treated as a conflict.
    const nativeDisagrees = native !== "UNKNOWN" && native !== explicit.mode;
    return {
      mode: explicit.mode,
      source: "EXPLICIT",
      conflict: false,
      diagnostic: nativeDisagrees ? "EXPLICIT_OVERRODE_NATIVE" : "NONE",
    };
  }

  // No explicit signal — only a trusted native negative may stand alone.
  if (NATIVE_TRUSTED_NEGATIVES.has(native)) {
    return { mode: native, source: "NATIVE", conflict: false, diagnostic: "NONE" };
  }
  if (native === "DELIVERY" || native === "PICKUP_POINT") {
    return { mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NATIVE_NOT_TRUSTED" };
  }
  return { mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NONE" };
}

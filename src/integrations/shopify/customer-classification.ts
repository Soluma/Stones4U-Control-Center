// Phase 6W — the Stones4U customer classification contract: how the two
// Shopify Customer metafields that already exist in Shopify Admin are read
// into strict internal values.
//
// WHY THESE LIVE ON THE CUSTOMER, NOT THE ORDER (Fons, Phase 6W):
// Payment policy and customer type are properties of the *customer*, not of
// any individual order. They are therefore deliberately NOT copied onto Draft
// customAttributes by OfferteApp: duplicating them per-order would create two
// competing sources of truth that could disagree the moment a customer's
// arrangement changes. Control Center reads them live from the attached
// Shopify Customer instead.
//
// TWO INDEPENDENT AXES — this separation is non-negotiable (build instruction
// §3). BUSINESS does not imply ON_ACCOUNT. All of these are real, valid
// combinations at Stones4U:
//
//   BUSINESS + PREPAID      — a company that simply pays up front
//   BUSINESS + ON_ACCOUNT   — a company invoiced afterwards
//   CONSUMER + PREPAID      — the ordinary retail case
//
// Only `paymentPolicy` decides whether payment gates a delivery request.
// `customerType` is CRM/business context and must never substitute for it.
//
// Lives in integrations/shopify rather than modules/delivery for the same
// reason fulfillment-contract.ts does: order-for-handoff.ts is an
// integrations-layer file and must return an already-parsed result, and this
// repo's module boundary (CLAUDE.md) forbids integrations depending on
// modules.

/** Namespace of both classification metafields.
 *
 * VERIFIED, NOT ASSUMED (build instruction §1): read live from the
 * development shop's `metafieldDefinitions(ownerType: CUSTOMER)` on
 * 2026-09-10. The brief explicitly warned against assuming `custom`; on the
 * development shop it genuinely is `custom`, for both keys. */
export const CUSTOMER_CLASSIFICATION_NAMESPACE = "custom";

/** Exact metafield keys. Case-sensitive; a differently-cased key is simply a
 * different metafield and is not this signal. */
export const PAYMENT_POLICY_METAFIELD_KEY = "payment_policy";
export const CUSTOMER_TYPE_METAFIELD_KEY = "customer_type";

/**
 * Whether payment is required before Stones4U asks this customer for delivery
 * details.
 *
 * `UNKNOWN` is the deliberate fail-closed answer for absent, unparseable, or
 * unreadable — never a synonym for "probably prepaid". Nothing may be
 * inferred from company name, VAT number, tags, email domain, whether the
 * Order happens to be paid, the shipping address, or `sourceName` (build
 * instruction §2).
 */
export type PaymentPolicy = "PREPAID" | "ON_ACCOUNT" | "UNKNOWN";

/** Business context only. Never decides payment timing (build instruction §3). */
export type CustomerType = "CONSUMER" | "BUSINESS" | "UNKNOWN";

/**
 * Outcome of reading one classification metafield.
 *
 * `DUPLICATE` is deliberately absent, unlike the fulfillment contract's
 * equivalent: Shopify enforces one metafield per (owner, namespace, key), and
 * this reader addresses both fields by exact namespace/key rather than
 * enumerating them, so a duplicate cannot be surfaced by this access pattern
 * (build instruction §4). If a future reader ever switches to enumeration, it
 * will need to reintroduce that case explicitly.
 */
export type ClassificationRead<T> =
  | { status: "ABSENT" }
  | { status: "VALID"; value: T }
  | { status: "INVALID"; rawLength: number };

/**
 * The exact Shopify choice strings configured on the metafield definitions,
 * mapped to internal values.
 *
 * VERIFIED AGAINST THE DEVELOPMENT SHOP on 2026-09-10 — and one of them is
 * NOT what was expected. The Phase 6W brief described the payment_policy
 * choices as "vooraf" / "op rekening"; the definition actually configured on
 * the development shop is **"betaling vooraf"** / "op rekening". That is
 * exactly the discrepancy build instruction §1 ("DO NOT GUESS") existed to
 * catch, and it is why only verified literals appear here.
 *
 * The production shop's definitions could NOT be enumerated this phase (no
 * read path was available to it — see the Phase 6W report), so if production
 * is configured with a different spelling, production reads will land on
 * INVALID -> UNKNOWN. That is the safe direction: it suppresses automation
 * rather than enabling it wrongly. Adding a verified production spelling here
 * later is a one-line change, and MUST be done from a live read, never from
 * memory.
 */
export const PAYMENT_POLICY_VALUES: Readonly<Record<string, PaymentPolicy>> = {
  "betaling vooraf": "PREPAID",
  "op rekening": "ON_ACCOUNT",
};

export const CUSTOMER_TYPE_VALUES: Readonly<Record<string, CustomerType>> = {
  particulier: "CONSUMER",
  zakelijk: "BUSINESS",
};

/**
 * Normalization is explicitly defined, not guessed — the same discipline as
 * readExplicitFulfillmentMode(). Exactly three lossless transformations are
 * applied: surrounding whitespace is trimmed, internal whitespace runs are
 * collapsed to a single space, and the result is lower-cased.
 *
 * Whitespace collapsing is not paranoia here: the same shop's `aanspreekvorm`
 * definition has choices configured with genuine trailing spaces
 * ("Dhr. ", "Mevr. "), so trailing/awkward whitespace in a Shopify choice
 * list is a demonstrated reality on this exact shop.
 *
 * None of the three can turn one valid value into a different valid value, so
 * the mapping stays unambiguous. Nothing else is accepted: no synonyms, no
 * fuzzy matching, no translation. "prepaid", "vooraf" (on its own),
 * "Op Rekening " and "zakelijke klant" are handled strictly by this table —
 * whatever is not an exact configured choice after normalization is INVALID,
 * never coerced.
 */
function normalize(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function parse<T>(raw: string | null | undefined, table: Readonly<Record<string, T>>): ClassificationRead<T> {
  if (raw === null || raw === undefined) return { status: "ABSENT" };

  const normalized = normalize(raw);
  // An empty (or whitespace-only) metafield states nothing, so it is treated
  // as nothing stated rather than as a data fault.
  if (normalized === "") return { status: "ABSENT" };

  const mapped = table[normalized];
  if (mapped === undefined) {
    // Deliberately records only the LENGTH of the offending value, never the
    // value itself: this can end up in logs, and a metafield is free text as
    // far as this reader is concerned.
    return { status: "INVALID", rawLength: raw.length };
  }
  return { status: "VALID", value: mapped };
}

export function readPaymentPolicy(raw: string | null | undefined): ClassificationRead<PaymentPolicy> {
  return parse(raw, PAYMENT_POLICY_VALUES);
}

export function readCustomerType(raw: string | null | undefined): ClassificationRead<CustomerType> {
  return parse(raw, CUSTOMER_TYPE_VALUES);
}

// ─────────────────────────────────────────────────────────────────────
// PHASE 6AD — THESE METAFIELDS ARE EXCEPTION FIELDS
//
// Fons' business rule: the ordinary Stones4U customer is a private individual
// who pays up front. The metafields exist to record the EXCEPTIONS, not to
// classify everybody. Requiring all ~5,600 production customers to be tagged
// before anything could work would have been a data-entry project standing in
// for a business rule.
//
// So an ABSENT value is now an intentional statement of the default, not an
// absence of information:
//
//   payment_policy absent -> PREPAID
//   customer_type  absent -> CONSUMER
//
// THE CRITICAL DISTINCTION, and the reason this is more than a two-line
// change: "nobody needed to say anything" and "we could not find out" look
// identical once both produce a value, and they must never be confused.
// Defaults apply ONLY to a successful read of a real customer that simply has
// no value stored. They are NOT applied when:
//
//   * the stored value is INVALID  — somebody said something we cannot trust;
//     an explicit bad value is not the same as no value (build instruction §4)
//   * the read FAILED/timed out/was unauthorized — we do not know whether a
//     value exists, so assuming the default would be inventing a fact (§5)
//   * the Order has NO CUSTOMER at all — a guest/unlinked Order is not "a
//     normal customer with empty metafields" (§6)
//
// All three of those remain UNKNOWN, exactly as before.
// ─────────────────────────────────────────────────────────────────────

/** The ordinary Stones4U customer, assumed when nothing is stored. */
export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = "PREPAID";
export const DEFAULT_CUSTOMER_TYPE: CustomerType = "CONSUMER";

/**
 * Where a resolved value came from. Kept per-field so a default can never be
 * mistaken for a statement, and a fail-closed UNKNOWN can never be mistaken
 * for a default (build instruction §1 — diagnostic information must survive
 * the introduction of defaults).
 */
export type ClassificationValueSource = "EXPLICIT" | "DEFAULT" | "FAIL_CLOSED";

/**
 * What the read itself observed, independent of what value was resolved.
 * A superset of the four states build instruction §1 requires; `NO_CUSTOMER`
 * is separated from `UNREADABLE` because "there was nobody to ask" and
 * "asking failed" call for different operational responses.
 */
export type ClassificationReadState = "VALID" | "ABSENT" | "INVALID" | "UNREADABLE" | "NO_CUSTOMER";

/** Applies the exception-field rule to one read. */
export function resolvePaymentPolicy(
  read: ClassificationRead<PaymentPolicy>,
): { value: PaymentPolicy; source: ClassificationValueSource } {
  if (read.status === "VALID") return { value: read.value, source: "EXPLICIT" };
  if (read.status === "ABSENT") return { value: DEFAULT_PAYMENT_POLICY, source: "DEFAULT" };
  return { value: "UNKNOWN", source: "FAIL_CLOSED" };
}

export function resolveCustomerType(
  read: ClassificationRead<CustomerType>,
): { value: CustomerType; source: ClassificationValueSource } {
  if (read.status === "VALID") return { value: read.value, source: "EXPLICIT" };
  if (read.status === "ABSENT") return { value: DEFAULT_CUSTOMER_TYPE, source: "DEFAULT" };
  return { value: "UNKNOWN", source: "FAIL_CLOSED" };
}

/** What the classification read did, for observability. `UNREADABLE` is the
 * fail-closed outcome when Shopify could not be asked at all (build
 * instruction §6) — structurally distinct from "the customer has no value
 * set", because the two need different operational responses. */
export type CustomerClassificationSource = "CUSTOMER_METAFIELDS" | "NO_CUSTOMER" | "UNREADABLE";

export type CustomerClassification = {
  /** The effective value: explicit, defaulted, or UNKNOWN. */
  paymentPolicy: PaymentPolicy;
  customerType: CustomerType;
  /** How the customer was read as a whole. */
  source: CustomerClassificationSource;
  /** What the read observed for each field, before defaults were applied. */
  paymentPolicyStatus: ClassificationReadState;
  customerTypeStatus: ClassificationReadState;
  /** Whether each effective value was stated, defaulted, or failed closed. */
  paymentPolicySource: ClassificationValueSource;
  customerTypeSource: ClassificationValueSource;
};

/**
 * The fail-closed result, for an Order with no customer and for a failed read
 * (build instructions §5 and §6).
 *
 * **This deliberately does NOT get the new defaults.** It is the single place
 * where that decision is visible, so the difference between "an ordinary
 * customer with nothing stored" (CONSUMER + PREPAID) and "we could not
 * establish anything" (UNKNOWN) stays a property of the type rather than a
 * convention someone has to remember.
 */
export function unclassifiedCustomer(source: CustomerClassificationSource): CustomerClassification {
  const state: ClassificationReadState = source === "NO_CUSTOMER" ? "NO_CUSTOMER" : "UNREADABLE";
  return {
    paymentPolicy: "UNKNOWN",
    customerType: "UNKNOWN",
    source,
    paymentPolicyStatus: state,
    customerTypeStatus: state,
    paymentPolicySource: "FAIL_CLOSED",
    customerTypeSource: "FAIL_CLOSED",
  };
}

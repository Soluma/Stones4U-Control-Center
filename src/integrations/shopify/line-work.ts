// "Werk" and "Referentie" per order line — the project a B2B customer
// ordered that line for. They live on the Shopify line item itself as
// LineItem.customAttributes, written by OfferteApp and the kassa (Source2POS)
// when they build the Draft Order. Shopify is the source; the CRM only reads.
//
// The keys are a shared contract between the Stones4U apps: exactly "Werk"
// and "Referentie", case-sensitive. Every other attribute on a line (such as
// the kassa's technical `_s2p_cart_line_id`) is ignored here on purpose.

export const LINE_WORK_KEY = "Werk";
export const LINE_REFERENCE_KEY = "Referentie";

export type LineAttribute = { key: string; value: string | null };

export type LineWork = {
  werk: string | null;
  referentie: string | null;
};

// Writers already clean the value, but Shopify accepts anything, so the
// reader does not trust that: control characters (incl. line breaks) go,
// runs of whitespace become one space, and an empty result means "absent".
// HTML is not stripped here — React escapes it on output.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export function cleanLineWorkValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

function firstValue(attributes: readonly LineAttribute[], key: string): string | null {
  const attribute = attributes.find((candidate) => candidate.key === key);
  return attribute ? cleanLineWorkValue(attribute.value) : null;
}

export function parseLineWork(attributes: readonly LineAttribute[] | null | undefined): LineWork {
  const list = Array.isArray(attributes) ? attributes : [];
  return {
    werk: firstValue(list, LINE_WORK_KEY),
    referentie: firstValue(list, LINE_REFERENCE_KEY),
  };
}

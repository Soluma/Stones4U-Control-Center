// Single, consistent Dutch phone-number normalization used EVERYWHERE a
// phone number is stored or matched in Control Center. Discovery found this
// was exactly the gap that caused real bugs elsewhere in the landscape:
// TelefoonSysteem normalizes differently on its /contacts/ensure path than
// on its AMI-worker call-matching path (docs/platform-discovery/22 §2),
// causing silent match failures. There is exactly one normalizer here, used
// by every caller — no second implementation is allowed to exist.

/** Normalizes to a comparable digits-only form with a Dutch country code
 * (31...), e.g. "06-12345678", "+31 6 12345678", "0031612345678" all become
 * "31612345678". Returns null for input that isn't plausibly a phone number. */
export function normalizeDutchPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/[\s\-().]/g, "");
  if (!/^\+?\d{6,15}$/.test(stripped)) return null;

  let digits = stripped.replace(/^\+/, "");
  if (digits.startsWith("0031")) digits = `31${digits.slice(4)}`;
  else if (digits.startsWith("31") && digits.length >= 11) digits = digits;
  else if (digits.startsWith("0")) digits = `31${digits.slice(1)}`;
  else if (!digits.startsWith("31")) digits = `31${digits}`;

  return digits;
}

/** Phase 6c — a safe `tel:` href for a quick-action link, or null when the
 * input isn't plausibly a phone number. Deliberately NOT
 * `normalizeDutchPhone()`: that function forces every number into a
 * Dutch-31-prefixed form (correct for matching/comparison), which would
 * silently corrupt a genuine international number that doesn't start with
 * 31/0031/0 (discovery doc 49 §4/build spec §3) — a `tel:` link must
 * preserve the number as given, only formatting-cleaned and shape-
 * validated. Reuses the exact same strip/validate pattern as
 * normalizeDutchPhone() for consistency, without the country-code rewrite. */
export function buildTelHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?\d{6,15}$/.test(stripped)) return null;
  return `tel:${stripped}`;
}

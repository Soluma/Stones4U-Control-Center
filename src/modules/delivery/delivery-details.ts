// Phase 6P — the two extra pieces of delivery information a customer may
// give alongside their requested date: a free-text remark and whether the
// location is reachable by a large truck.
//
// Both are Control Center-only (build instruction §10): they are NOT mirrored
// to Shopify, because whether arbitrary Order customAttributes surface on
// customer-facing Shopify templates is still unresolved (Phase 6O §13). Only
// `requested_delivery_date`, which was already mirrored before this phase,
// continues to be.
//
// Phase 6Q — both fields resolve to a PATCH, not a value, because "the
// client said nothing" and "the client said empty" are different statements
// and must not collapse into the same write. A submission that omits a field
// (a browser tab opened before the deploy, an older caller, any request that
// only carries the date) must leave the stored value exactly as it was —
// silently erasing a customer's access instructions on their next resubmit
// would be real, unrecoverable data loss.

export const DELIVERY_COMMENT_MAX_LENGTH = 500;

/** PRESERVE = the field was absent, so whatever is stored stays stored.
 * SET = the field was present and carries the new value (`null` clears). */
export type DeliveryFieldPatch<T> = { action: "PRESERVE" } | { action: "SET"; value: T };

export const PRESERVE = { action: "PRESERVE" } as const;

export type DeliveryCommentPatchResult =
  | { ok: true; patch: DeliveryFieldPatch<string | null> }
  | { ok: false; message: string };

/**
 * Resolves the optional customer remark into a patch.
 *
 * - `undefined` (property absent) → PRESERVE.
 * - `null`, `""` or whitespace-only → SET null, i.e. deliberately cleared.
 * - text → SET the trimmed text.
 *
 * Outer whitespace is trimmed while internal line breaks are preserved, so a
 * two-line access instruction stays two lines. Length is measured after
 * trimming and enforced here on the server, not only by the textarea's
 * maxLength.
 *
 * The value is stored and rendered as plain text and is never parsed as HTML
 * or markdown: React interpolation escapes it on output, so a remark
 * containing `<script>` reaches staff as those literal characters.
 */
export function resolveDeliveryCommentPatch(raw: string | null | undefined): DeliveryCommentPatchResult {
  if (raw === undefined) return { ok: true, patch: PRESERVE };
  if (raw === null) return { ok: true, patch: { action: "SET", value: null } };

  if (typeof raw !== "string") {
    return { ok: false, message: "Ongeldige opmerking." };
  }

  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, patch: { action: "SET", value: null } };

  if (trimmed.length > DELIVERY_COMMENT_MAX_LENGTH) {
    return {
      ok: false,
      message: `De opmerking mag maximaal ${DELIVERY_COMMENT_MAX_LENGTH} tekens bevatten.`,
    };
  }
  return { ok: true, patch: { action: "SET", value: trimmed } };
}

/**
 * Resolves the large-truck accessibility answer into a patch.
 *
 * Only a real boolean is an answer. `true` and `false` are both stored;
 * anything else — absent, null, a string, a number — means the caller did not
 * answer, so the stored value is preserved rather than overwritten with a
 * fabricated `false`.
 *
 * The three stored states stay genuinely distinct, and the distinction
 * matters:
 * - `true`  — the customer positively confirmed a large truck can reach,
 *             manoeuvre and unload at the location.
 * - `false` — the customer did NOT confirm it. This is **not** a claim that
 *             the location is inaccessible; an unchecked box only means the
 *             question went unanswered in the affirmative.
 * - `null`  — never asked (every row from before this phase).
 *
 * Accessibility is logistics information and never blocks a submission.
 */
export function resolveLargeTruckAccessPatch(raw: unknown): DeliveryFieldPatch<boolean> {
  if (raw === true) return { action: "SET", value: true };
  if (raw === false) return { action: "SET", value: false };
  return PRESERVE;
}

/** The one place the three states are turned into staff-facing Dutch, so no
 * caller can accidentally render `false` as "inaccessible". */
export function formatLargeTruckAccess(value: boolean | null | undefined): string {
  if (value === true) return "Bereikbaar met grote vrachtwagen: bevestigd";
  if (value === false) return "Bereikbaar met grote vrachtwagen: niet bevestigd";
  return "Bereikbaarheid grote vrachtwagen: onbekend";
}

// Single, consistent email normalization for customer matching
// (docs/architecture/ADR-007-CUSTOMER-MATCHING-LAYER.md rule 1) — mirrors
// src/lib/phone.ts: exactly one normalizer, used by every caller, so this
// layer never repeats TelefoonSysteem's own inconsistency (different
// normalization on different code paths, docs/platform-discovery/22 §2).
//
// Deliberately trim + lowercase only, no "+alias" stripping. A Gmail-style
// "+order" tag (name+order@domain.com) is a real, distinct mailbox alias in
// many providers' delivery rules, not reliably an alias of the base
// address — stripping it would risk merging two different people's mail.
// If this proves too strict in practice (Phase 3c), it's a deliberate,
// separately-reviewed change, not a default assumption.
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // Minimal shape check — one @, something on both sides. Not a full RFC
  // validator (not this function's job); just enough to reject obvious
  // non-email input rather than silently normalizing garbage.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

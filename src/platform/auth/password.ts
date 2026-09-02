import { hash, verify } from "@node-rs/argon2";

// argon2id, the strongest of the three password-hashing schemes already in
// use across the Stones4U landscape (POS: argon2; OfferteApp: Werkzeug's
// default; TelefoonSysteem: bcryptjs) — chosen deliberately, not by default.
// See docs/platform-discovery/14-SHARED-CORE-DESIGN.md.
const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain);
  } catch {
    // A malformed/foreign hash must never throw into a login flow — treat as
    // "does not match" rather than a 500.
    return false;
  }
}

export function isPasswordStrongEnough(plain: string): boolean {
  return plain.length >= 10;
}

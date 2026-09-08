import "server-only";
import { randomBytes, createHash, createHmac } from "node:crypto";

// Public bearer token for DeliveryDateHandoff — the sole authorization
// mechanism for the unauthenticated /delivery/[token] flow (no session, no
// cookie). Same technique as Session.tokenHash
// (src/platform/auth/session.ts): a 256-bit CSPRNG raw token, only its
// HMAC-SHA256 hash ever persisted.
//
// A dedicated DELIVERY_HANDOFF_TOKEN_SECRET (not SESSION_SECRET) is used
// deliberately — these are different token classes with different exposure
// surfaces (a delivery-handoff token is emailed/shared outside a session,
// a session token never leaves an httpOnly cookie) and different rotation
// needs; mixing the HMAC key would couple two unrelated concerns for no
// benefit. This file is self-contained rather than extracting a shared
// helper out of session.ts — session.ts is existing, working code outside
// this feature's scope.

const RAW_TOKEN_BYTES = 32;

export function generatePublicToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

let warnedMissingTokenSecret = false;

export function hashPublicToken(rawToken: string): string {
  const secret = process.env.DELIVERY_HANDOFF_TOKEN_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DELIVERY_HANDOFF_TOKEN_SECRET ontbreekt in de environment (verplicht in productie).");
    }
    if (!warnedMissingTokenSecret) {
      console.warn(
        "DELIVERY_HANDOFF_TOKEN_SECRET is niet gezet — delivery-handoff-tokens gebruiken een onveilige ontwikkel-fallback. Zet DELIVERY_HANDOFF_TOKEN_SECRET vóór een productie-deploy.",
      );
      warnedMissingTokenSecret = true;
    }
    return createHash("sha256").update(`dev-insecure-fallback:${rawToken}`).digest("hex");
  }

  return createHmac("sha256", secret).update(rawToken).digest("hex");
}

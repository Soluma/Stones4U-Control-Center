import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Verifies an `Authorization: Bearer <token>` header against the token in
 * env var `envName`, in constant time. An unset/short env token means the
 * endpoint is closed (fail closed) — never "open because unconfigured".
 */
export function verifyBearerToken(authorizationHeader: string | null, envName: string): boolean {
  const expected = process.env[envName]?.trim() ?? "";
  if (expected.length < 32) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader?.trim() ?? "");
  if (!match) return false;
  const a = createHash("sha256").update(match[1]!.trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

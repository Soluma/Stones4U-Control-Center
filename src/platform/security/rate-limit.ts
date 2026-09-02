// Minimal in-memory rate limiter for the login route (Phase 1 has a single
// app instance, so this is sufficient — same documented tradeoff s4u-quote-
// app made for its own rate limiter). Every one of the three existing auth
// systems discovery looked at (POS, OfferteApp, TelefoonSysteem) had NO rate
// limiting on login at all — this is a deliberate improvement, not a
// carried-over pattern.

const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export function resetRateLimit(key: string): void {
  attempts.delete(key);
}

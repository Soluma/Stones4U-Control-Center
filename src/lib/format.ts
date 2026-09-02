// All dates are shown in Europe/Amsterdam explicitly — Prisma stores
// DateTime values UTC-normalized regardless of the underlying Postgres
// TIMESTAMP(3) (no tz) column, but Intl.DateTimeFormat without an explicit
// `timeZone` falls back to the JS RUNTIME's local zone. On a server that
// defaults to UTC (the common case for Fly.io/Docker machines), that would
// silently show Dutch staff times 1-2 hours off from local time. Found
// during the Phase 1 production readiness review — see
// docs/build/PHASE-1-PRODUCTION-READINESS.md ("Activity Timeline" /
// timezone handling). POS (Kassa Systeem) already solved the equivalent
// day-boundary problem the same way, for the same reason.
const AMSTERDAM_TZ = "Europe/Amsterdam";

export function formatMoney(money: { amount: string; currencyCode: string } | null | undefined): string {
  if (!money) return "—";
  const value = Number(money.amount);
  if (Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: money.currencyCode }).format(value);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("nl-NL", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: AMSTERDAM_TZ,
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("nl-NL", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: AMSTERDAM_TZ,
  }).format(date);
}

// Next.js startup hook. Op rekening v1 scheduler: an in-process timer on the
// CRM's always-on machines (fly.toml: min_machines_running = 1,
// auto_stop_machines = false), so no extra machine is needed. Fly's own
// machine schedules only go down to "hourly", too coarse for invoicing
// shortly after a pickup.
//
// The timer does nothing but POST to this machine's own
// /api/internal/on-account/run with the worker token — the same route and the
// same idempotent service a manual call uses. Overlap between ticks and
// between machines is prevented there (PostgreSQL advisory lock).
//
// Off unless ON_ACCOUNT_SCHEDULER_ENABLED === "true". The route itself also
// refuses while ON_ACCOUNT_SERVICE_ENABLED is not "true".

const MIN_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ON_ACCOUNT_SCHEDULER_ENABLED !== "true") return;
  const token = process.env.ON_ACCOUNT_WORKER_TOKEN;
  if (!token) {
    console.error(JSON.stringify({ event: "on_account_scheduler_not_started", reason: "ON_ACCOUNT_WORKER_TOKEN missing" }));
    return;
  }
  const configured = Number(process.env.ON_ACCOUNT_SCHEDULER_INTERVAL_MS);
  const intervalMs = Number.isFinite(configured) && configured >= MIN_INTERVAL_MS ? configured : DEFAULT_INTERVAL_MS;
  const url = `http://127.0.0.1:${process.env.PORT ?? "3000"}/api/internal/on-account/run`;

  let busy = false;
  const tick = async () => {
    if (busy) return; // this machine's previous tick still running
    busy = true;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-on-account-trigger": "scheduler" },
        signal: AbortSignal.timeout(intervalMs),
      });
      if (!response.ok && response.status !== 503) {
        console.error(JSON.stringify({ event: "on_account_scheduler_tick_failed", status: response.status }));
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "on_account_scheduler_tick_failed", error: error instanceof Error ? error.name : "unknown" }));
    } finally {
      busy = false;
    }
  };

  // Random first delay spreads the machines; later ticks keep that offset.
  const firstDelay = 30_000 + Math.floor(Math.random() * 60_000);
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), intervalMs).unref();
  }, firstDelay).unref();
  console.log(JSON.stringify({ event: "on_account_scheduler_started", intervalMs, firstDelayMs: firstDelay }));
}

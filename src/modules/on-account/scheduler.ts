import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { runOnAccountWorker, type PickupEventSource } from "./on-account.service";

// Op rekening v1 — one scheduled pass of the payment-due service. The
// scheduler (src/instrumentation.ts, an in-process timer on the CRM's
// always-on machines) only ever calls POST /api/internal/on-account/run,
// which lands here; so do manual calls. This adds exactly three things on
// top of the idempotent worker, and no business logic:
//   1. a PostgreSQL advisory lock, so two passes (two machines, a timer tick
//      and a manual call) never overlap — the loser returns SKIPPED_LOCKED;
//   2. a deadline (no new order is started after it; the lock is released
//      when the run ends or the transaction times out);
//   3. one structured log line per run, plus an audit event when a run fails.

/** Arbitrary, fixed 64-bit key for pg_try_advisory_xact_lock — unique to this job. */
export const ON_ACCOUNT_SCHEDULER_LOCK_KEY = BigInt("7310428815563001");
export const DEFAULT_RUN_DEADLINE_MS = 4 * 60_000;
const LOCK_SLACK_MS = 60_000;

export type ScheduledRunResult =
  | { status: "SKIPPED_LOCKED"; durationMs: number }
  | {
      status: "RAN";
      durationMs: number;
      advanced: number;
      polled: number;
      stoppedByDeadline: boolean;
      byState: Record<string, number>;
      pollOutcomes: Record<string, number>;
    }
  | { status: "FAILED"; durationMs: number; error: string };

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export async function runScheduledOnAccountPass(options: {
  trigger: string;
  pickupEvents?: PickupEventSource;
  deadlineMs?: number;
  limit?: number;
}): Promise<ScheduledRunResult> {
  const startedAt = Date.now();
  const deadlineMs = options.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  let result: ScheduledRunResult;
  try {
    result = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${ON_ACCOUNT_SCHEDULER_LOCK_KEY}) AS locked`;
        if (!rows[0]?.locked) return { status: "SKIPPED_LOCKED", durationMs: Date.now() - startedAt } as const;
        // The worker uses its own pooled connections; this transaction only
        // holds the lock for the duration of the pass.
        const run = await runOnAccountWorker({
          limit: options.limit ?? 25,
          pickupEvents: options.pickupEvents,
          deadlineAt: startedAt + deadlineMs,
        });
        return {
          status: "RAN",
          durationMs: Date.now() - startedAt,
          advanced: run.advanced.length,
          polled: run.polled.length,
          stoppedByDeadline: run.stoppedByDeadline,
          byState: countBy(run.advanced.map((a) => a.state)),
          pollOutcomes: countBy(run.polled.map((p) => p.outcome.split(" ")[0] ?? p.outcome)),
        } as const;
      },
      { maxWait: 10_000, timeout: deadlineMs + LOCK_SLACK_MS },
    );
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300);
    result = { status: "FAILED", durationMs: Date.now() - startedAt, error: message };
    await logAudit({
      userId: null,
      action: "on_account.scheduler_failed",
      entityType: "OnAccountOrder",
      entityId: "scheduler",
      metadata: { trigger: options.trigger, error: message },
    }).catch(() => {});
  }
  const line = { event: "on_account_scheduler_run", trigger: options.trigger, ...result };
  if (result.status === "FAILED") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
  return result;
}

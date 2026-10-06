import type { TaskStatus } from "@/generated/prisma";

/** The statuses that count as "still to do" — the one definition used by
 * task lists, the dashboard summary, Mijn Werk and the Taken badge in the
 * sidebar. DONE and CANCELLED are closed. */
export const OPEN_TASK_STATUSES: TaskStatus[] = ["OPEN", "IN_PROGRESS", "WAITING"];

/** Badge text for a count of open tasks: nothing for 0, "99+" above 99. */
export function taskBadgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}

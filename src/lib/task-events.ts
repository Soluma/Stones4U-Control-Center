"use client";

/** A task was created, completed, reopened, reassigned or otherwise changed
 * in this browser tab. The sidebar's Taken badge listens and fetches its
 * count once — no polling. */
export const TASKS_CHANGED_EVENT = "cc:tasks-changed";

export function notifyTasksChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
}

import Link from "next/link";
import { AlertTriangle, Clock } from "lucide-react";
import { formatDate } from "@/lib/format";
import { customerDisplayName } from "@/modules/crm/customer-identity";
import type { MyWorkTask } from "@/modules/dashboard/my-work";

// Phase 6A — "Mijn Werk" taken-blok (docs/build/PHASE-6A-MY-WORK-STAGING.md).
// Same row/link conventions as OpenOpportunitiesBlock.tsx and the existing
// "Komende afspraken" dashboard section — no new visual pattern introduced.
export function MyWorkTasksList({ tasks }: { tasks: MyWorkTask[] }) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium text-ink-secondary">Taken</h3>
      {tasks.length === 0 ? (
        <p className="cc-card p-4 text-sm text-ink-tertiary">Geen openstaande taken voor vandaag.</p>
      ) : (
        <div className="cc-card divide-y divide-border-subtle">
          {tasks.map((task) => (
            <Link key={task.id} href={`/tasks/${task.id}`} className="cc-table-row flex items-center gap-3 px-4 py-2.5 text-sm">
              {task.urgency === "OVERDUE" ? (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger-500" aria-hidden />
              ) : (
                <Clock className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink-primary">{task.title}</span>
                <span className="block truncate text-xs text-ink-tertiary">
                  {task.customerProfile ? `${customerDisplayName(task.customerProfile)} · ` : ""}
                  {task.urgency === "OVERDUE" ? (
                    <span className="text-danger-500">Achterstallig sinds {formatDate(task.dueAt)}</span>
                  ) : (
                    "Vandaag"
                  )}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

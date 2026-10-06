"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Gem } from "lucide-react";
import { cn } from "@/lib/cn";
import { NAV_SECTIONS } from "./nav-config";
import { TASKS_CHANGED_EVENT } from "@/lib/task-events";
import { taskBadgeLabel } from "@/modules/tasks/task-status";

function isActiveHref(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Open tasks assigned to me. Starts from the server-rendered count and is
 * fetched again (once) whenever a task changes in this tab. */
function useOpenTaskCount(initial: number): number {
  const [count, setCount] = useState(initial);
  useEffect(() => setCount(initial), [initial]);
  useEffect(() => {
    let cancelled = false;
    async function reload() {
      try {
        const response = await fetch("/api/tasks/open-count", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { openAssignedToMe?: number };
        if (!cancelled && typeof data.openAssignedToMe === "number") setCount(data.openAssignedToMe);
      } catch {
        // keep the last known count
      }
    }
    window.addEventListener(TASKS_CHANGED_EVENT, reload);
    return () => {
      cancelled = true;
      window.removeEventListener(TASKS_CHANGED_EVENT, reload);
    };
  }, []);
  return count;
}

export function Sidebar({ openTaskCount = 0 }: { openTaskCount?: number }) {
  const pathname = usePathname();
  const taskBadge = taskBadgeLabel(useOpenTaskCount(openTaskCount));

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-border-subtle bg-surface md:flex">
      <div className="flex h-14 items-center gap-2 border-b border-border-subtle px-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-500 text-white">
          <Gem className="h-3.5 w-3.5" aria-hidden />
        </div>
        <span className="text-sm font-semibold tracking-tight text-ink-primary">Control Center</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label ?? "root"}>
            {section.label && (
              <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-disabled">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = item.href ? isActiveHref(pathname, item.href) : false;

                if (item.href) {
                  return (
                    <li key={item.label}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors cc-focus-ring",
                          active
                            ? "bg-accent-50 font-medium text-accent-700"
                            : "text-ink-secondary hover:bg-surface-hover hover:text-ink-primary",
                        )}
                      >
                        <Icon className={cn("h-4 w-4 shrink-0", active ? "text-accent-600" : "text-ink-tertiary")} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.href === "/tasks" && taskBadge && (
                          <span
                            data-testid="tasks-badge"
                            aria-label={`${taskBadge} open taken aan jou toegewezen`}
                            className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent-500 px-1.5 text-[11px] font-semibold tabular-nums leading-none text-white"
                          >
                            {taskBadge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                }

                return (
                  <li key={item.label}>
                    <span className="flex cursor-default items-center justify-between gap-2.5 rounded-md px-2 py-1.5 text-sm text-ink-disabled">
                      <span className="flex items-center gap-2.5">
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        {item.label}
                      </span>
                      {item.comingSoon && (
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-tertiary">
                          Binnenkort
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

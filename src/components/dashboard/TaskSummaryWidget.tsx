"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { TASKS_CHANGED_EVENT } from "@/lib/task-events";

type Summary = { assignedToMe: number; createdByMe: number; overdue: number; dueToday: number };

// Compacte totalen in één kaart. "Achterstallig" en "Vandaag klaar" tellen
// dezelfde taken die Mijn Werk → Taken als lijst toont (die lijst stopt bij
// 10); de tellers geven het volledige aantal en linken naar de takenlijst.
const ROWS: { key: keyof Summary; label: string; href: string; tone: "neutral" | "danger" | "accent" }[] = [
  { key: "assignedToMe", label: "Aan mij toegewezen", href: "/tasks?tab=assigned", tone: "accent" },
  { key: "overdue", label: "Achterstallig", href: "/tasks?tab=overdue", tone: "danger" },
  { key: "dueToday", label: "Vandaag klaar", href: "/tasks?tab=mine", tone: "neutral" },
  { key: "createdByMe", label: "Door mij aangemaakt", href: "/tasks?tab=created", tone: "neutral" },
];

const TONE_TEXT = { neutral: "text-ink-primary", danger: "text-danger-500", accent: "text-accent-600" };

export function TaskSummaryWidget() {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/tasks/summary")
        .then((r) => r.json())
        .then(setSummary)
        .catch(() => undefined);
    };
    load();
    window.addEventListener(TASKS_CHANGED_EVENT, load);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, load);
  }, []);

  return (
    <div className="cc-card grid grid-cols-2 [&>*]:border-border-subtle [&>*:nth-child(odd)]:border-r [&>*:nth-child(-n+2)]:border-b">
      {ROWS.map((row) => {
        const value = summary ? summary[row.key] : null;
        return (
          <Link key={row.key} href={row.href} className="cc-table-row min-w-0 px-4 py-3">
            <p className="truncate text-xs text-ink-tertiary">{row.label}</p>
            <p className={cn("mt-1 text-xl font-semibold tabular-nums", value === 0 ? "text-ink-tertiary" : TONE_TEXT[row.tone])}>
              {value ?? "—"}
            </p>
          </Link>
        );
      })}
    </div>
  );
}

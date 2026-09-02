"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ListTodo, ClipboardList, AlertTriangle, CalendarClock } from "lucide-react";
import { cn } from "@/lib/cn";

type Summary = { assignedToMe: number; createdByMe: number; overdue: number; dueToday: number };

const TILES: {
  key: keyof Summary;
  label: string;
  href: string;
  icon: typeof ListTodo;
  tone: "neutral" | "danger" | "accent";
}[] = [
  { key: "assignedToMe", label: "Aan mij toegewezen", href: "/tasks?tab=assigned", icon: ListTodo, tone: "accent" },
  { key: "createdByMe", label: "Door mij aangemaakt", href: "/tasks?tab=created", icon: ClipboardList, tone: "neutral" },
  { key: "overdue", label: "Achterstallig", href: "/tasks?tab=overdue", icon: AlertTriangle, tone: "danger" },
  { key: "dueToday", label: "Vandaag klaar", href: "/tasks?tab=mine", icon: CalendarClock, tone: "neutral" },
];

const TONE_TEXT = { neutral: "text-ink-primary", danger: "text-danger-500", accent: "text-accent-600" };
const TONE_ICON = { neutral: "text-ink-tertiary", danger: "text-danger-500", accent: "text-accent-500" };

export function TaskSummaryWidget() {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    fetch("/api/tasks/summary")
      .then((r) => r.json())
      .then(setSummary)
      .catch(() => undefined);
  }, []);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {TILES.map((tile) => {
        const Icon = tile.icon;
        return (
          <Link key={tile.key} href={tile.href} className="cc-card group p-4 transition-shadow hover:shadow-popover">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-ink-tertiary">{tile.label}</p>
              <Icon className={cn("h-3.5 w-3.5", TONE_ICON[tile.tone])} aria-hidden />
            </div>
            <p className={cn("mt-2 text-2xl font-semibold tabular-nums", TONE_TEXT[tile.tone])}>
              {summary ? summary[tile.key] : "—"}
            </p>
          </Link>
        );
      })}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Summary = { assignedToMe: number; createdByMe: number; overdue: number; dueToday: number };

const TILES: { key: keyof Summary; label: string; href: string; tone: "neutral" | "danger" | "accent" }[] = [
  { key: "assignedToMe", label: "Aan mij toegewezen", href: "/tasks?tab=assigned", tone: "accent" },
  { key: "createdByMe", label: "Door mij aangemaakt", href: "/tasks?tab=created", tone: "neutral" },
  { key: "overdue", label: "Achterstallig", href: "/tasks?tab=overdue", tone: "danger" },
  { key: "dueToday", label: "Vandaag klaar", href: "/tasks?tab=mine", tone: "neutral" },
];

const TONE_TEXT = { neutral: "text-ink-primary", danger: "text-danger-500", accent: "text-accent-600" };

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
      {TILES.map((tile) => (
        <Link key={tile.key} href={tile.href} className="cc-card p-4 transition-shadow hover:shadow-popover">
          <p className="text-xs font-medium text-ink-tertiary">{tile.label}</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${TONE_TEXT[tile.tone]}`}>
            {summary ? summary[tile.key] : "—"}
          </p>
        </Link>
      ))}
    </div>
  );
}

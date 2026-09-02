"use client";

import { usePathname } from "next/navigation";

// Lightweight page-context label for the Topbar — deliberately not a full
// breadcrumb trail (Phase 1's routes are shallow enough that one label is
// enough context), and deliberately client-side (usePathname) rather than
// threading a title prop through every page.tsx for a purely cosmetic label.
const ROUTE_LABELS: { test: (path: string) => boolean; label: string }[] = [
  { test: (p) => p === "/", label: "Dashboard" },
  { test: (p) => p === "/customers", label: "Klanten" },
  { test: (p) => /^\/customers\/[^/]+$/.test(p), label: "Customer 360" },
  { test: (p) => p === "/tasks", label: "Taken" },
  { test: (p) => p === "/admin/users", label: "Gebruikers" },
  { test: (p) => p === "/settings", label: "Instellingen" },
];

export function PageContext() {
  const pathname = usePathname();
  const match = ROUTE_LABELS.find((entry) => entry.test(pathname));
  if (!match) return null;

  return <p className="text-sm font-medium text-ink-secondary">{match.label}</p>;
}

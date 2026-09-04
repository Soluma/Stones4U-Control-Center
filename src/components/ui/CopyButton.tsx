"use client";

import { Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";

// Phase 6c — the interactive half of the shared copy helper (build spec
// §1.7). Deliberately a Client Component, not just a wrapped function: a
// raw onClick on a host element inside a Server Component (CustomerHeader.tsx
// is one) fails at render time — "Event handlers cannot be passed to Client
// Component props" — so any copy button used from a Server Component must
// cross the boundary as a component, not a prop. Client-side call sites
// (ContactsSection.tsx, etc.) use this too, for one single implementation.
export function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => copyToClipboard(value)}
      className="text-ink-tertiary hover:text-ink-secondary"
      aria-label={label}
      title="Kopiëren"
    >
      <Copy className="h-3 w-3" aria-hidden />
    </button>
  );
}

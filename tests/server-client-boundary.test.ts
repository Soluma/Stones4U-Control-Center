import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Scoped to the Customer 360 route only — the actual blast radius of the
// Phase 6c incident below — not the whole codebase. A codebase-wide version
// of this scan has real false positives (e.g. src/components/ui/Tabs.tsx
// deliberately supports both a Server-Component-safe `hrefFor` mode and a
// button+onClick `onSelect` mode, the latter only ever reached from a
// Client Component subtree such as TasksList.tsx) — this scan isn't a
// general RSC linter, just a guard on the one directory that broke.
const ROOT = "src/app/(app)/customers/[id]";

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsxFiles(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// Phase 6c incident: CustomerHeader.tsx (a Server Component, no "use
// client") got a raw `<button onClick={...}>` copy action added directly to
// it — a real staging 500 ("Event handlers cannot be passed to Client
// Component props"), since a Server Component can never pass a function as
// a prop (React can't serialize it across the RSC boundary). `next build`
// does not catch this for a dynamically-rendered route (no
// generateStaticParams), so it only ever surfaced at request time. This
// scan is the cheap, static guard: any Customer 360 file without a
// top-of-file "use client" directive must never contain an inline
// onXxx={...} handler.
describe("Server Component / Client Component boundary — Customer 360", () => {
  it("never defines an event-handler prop (onClick={...}, onChange={...}, ...) in a customers/[id] .tsx file that isn't a Client Component", () => {
    const offenders: string[] = [];
    for (const file of collectTsxFiles(ROOT)) {
      const content = readFileSync(file, "utf-8");
      const isClientComponent = /^\s*["']use client["'];?/.test(content);
      if (isClientComponent) continue;
      if (/\bon[A-Z]\w*\s*=\s*\{/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

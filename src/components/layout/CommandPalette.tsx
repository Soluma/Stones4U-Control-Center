"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type SearchGroup = {
  key: string;
  label: string;
  items: { id: string; title: string; subtitle: string; shopifyGid: string }[];
};

// Ctrl/Cmd+K command palette. Phase 1 scope is customer search only (see
// src/app/api/search/route.ts) but the group-based response shape is built
// so Phase 2+ (orders/quotes/products/suppliers/tasks/production jobs) can
// register additional groups without a UI rewrite — see
// docs/platform-discovery/25 "Command Search".
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setGroups([]);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => setGroups(data.groups ?? []))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, open]);

  async function openCustomer(item: SearchGroup["items"][number]) {
    setOpen(false);
    const response = await fetch("/api/customers/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopifyGid: item.shopifyGid }),
    });
    const data = await response.json();
    if (data.customerProfileId) router.push(`/customers/${data.customerProfileId}`);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="cc-btn-secondary text-ink-tertiary">
        <span>Zoeken…</span>
        <kbd className="ml-3 rounded border border-border bg-canvas px-1.5 py-0.5 text-[10px] font-medium">⌘K</kbd>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-primary/20 pt-[15vh] animate-fade-in" onClick={() => setOpen(false)}>
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-popover animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Zoek klanten op naam, bedrijf, e-mail of telefoon…"
          className="w-full border-b border-border-subtle bg-transparent px-4 py-3 text-sm outline-none placeholder:text-ink-tertiary"
        />
        <div className="max-h-80 overflow-y-auto p-2">
          {loading && <p className="px-3 py-4 text-sm text-ink-tertiary">Zoeken…</p>}
          {!loading && query.trim().length >= 2 && groups.every((g) => g.items.length === 0) && (
            <p className="px-3 py-4 text-sm text-ink-tertiary">Geen resultaten voor &ldquo;{query}&rdquo;.</p>
          )}
          {groups.map((group) => (
            <div key={group.key} className="mb-2">
              <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-disabled">
                {group.label}
              </p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => openCustomer(item)}
                  className="flex w-full flex-col items-start rounded-md px-3 py-2 text-left hover:bg-canvas"
                >
                  <span className="text-sm font-medium text-ink-primary">{item.title}</span>
                  {item.subtitle && <span className="text-xs text-ink-tertiary">{item.subtitle}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

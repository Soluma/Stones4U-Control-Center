"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2, LayoutDashboard, Users, CheckSquare, UserCog, Settings, ShoppingBag, FileText, TrendingUp } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";

type SearchItem = {
  id: string;
  kind: "customer" | "task" | "order" | "quote" | "opportunity" | "contact";
  title: string;
  subtitle: string;
  shopifyGid?: string;
  href?: string;
  customerProfileId?: string;
};
type SearchGroup = { key: string; label: string; items: SearchItem[] };

type NavItem = { id: string; title: string; subtitle: string; href: string };

// Static navigation shortcuts — never fetched from the API (docs/platform-
// discovery/26 §11: "Navigatie... statische lijst van routes"), filtered
// client-side against the current query.
const NAV_ITEMS: (NavItem & { icon: typeof LayoutDashboard })[] = [
  { id: "nav-dashboard", title: "Dashboard", subtitle: "/", href: "/", icon: LayoutDashboard },
  { id: "nav-customers", title: "Klanten", subtitle: "/customers", href: "/customers", icon: Users },
  { id: "nav-tasks", title: "Taken", subtitle: "/tasks", href: "/tasks", icon: CheckSquare },
  { id: "nav-users", title: "Gebruikers", subtitle: "/admin/users", href: "/admin/users", icon: UserCog },
  { id: "nav-settings", title: "Instellingen", subtitle: "/settings", href: "/settings", icon: Settings },
];

// Ctrl/Cmd+K command palette. Phase 2 scope: customers + tasks (from the
// API, see src/app/api/search/route.ts) + a static navigation group — see
// docs/platform-discovery/26 §11.
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [opening, setOpening] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const navMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return NAV_ITEMS.filter((item) => item.title.toLowerCase().includes(q));
  }, [query]);

  const flatItems: (SearchItem | NavItem)[] = [...groups.flatMap((g) => g.items), ...navMatches];

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 10);
    } else {
      setQuery("");
      setGroups([]);
      setActiveIndex(0);
    }
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
        .then((data) => {
          setGroups(data.groups ?? []);
          setActiveIndex(0);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, open]);

  async function selectItem(item: SearchItem | NavItem) {
    if ("href" in item && item.href && !("kind" in item)) {
      // static navigation item
      setOpen(false);
      router.push(item.href);
      return;
    }
    const searchItem = item as SearchItem;
    if ((searchItem.kind === "task" || searchItem.kind === "opportunity" || searchItem.kind === "contact") && searchItem.href) {
      setOpen(false);
      router.push(searchItem.href);
      return;
    }
    if (searchItem.kind === "quote" && searchItem.customerProfileId) {
      setOpen(false);
      router.push(`/customers/${searchItem.customerProfileId}?tab=orders`);
      return;
    }
    if ((searchItem.kind === "customer" || searchItem.kind === "order") && searchItem.shopifyGid) {
      setOpening(true);
      const response = await fetch("/api/customers/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopifyGid: searchItem.shopifyGid }),
      });
      const data = await response.json();
      setOpen(false);
      setOpening(false);
      if (data.customerProfileId) {
        const tab = searchItem.kind === "order" ? "?tab=orders" : "";
        router.push(`/customers/${data.customerProfileId}${tab}`);
      }
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (flatItems.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = flatItems[activeIndex];
      if (target) void selectItem(target);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="cc-btn-secondary text-ink-tertiary">
        <Search className="h-3.5 w-3.5" aria-hidden />
        <span>Zoeken…</span>
        <kbd className="ml-2 rounded border border-border bg-canvas px-1.5 py-0.5 text-[10px] font-medium">⌘K</kbd>
      </button>
    );
  }

  let renderedIndex = -1;
  const allGroups: { key: string; label: string; items: (SearchItem | NavItem)[] }[] = [
    ...groups,
    ...(navMatches.length > 0 ? [{ key: "navigation", label: "Navigatie", items: navMatches }] : []),
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-primary/20 pt-[15vh] animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Zoeken"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-surface shadow-popover animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-tertiary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Zoek klanten, taken, orders, of navigeer…"
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-ink-tertiary"
          />
          {(loading || opening) && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-tertiary" aria-hidden />}
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {!loading && query.trim().length >= 2 && flatItems.length === 0 && (
            <p className="px-3 py-4 text-sm text-ink-tertiary">Geen resultaten voor &ldquo;{query}&rdquo;.</p>
          )}
          {allGroups.map((group) => (
            <div key={group.key} className="mb-2">
              <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-disabled">
                {group.label}
              </p>
              {group.items.map((item) => {
                renderedIndex += 1;
                const isActive = renderedIndex === activeIndex;
                const Icon: typeof LayoutDashboard | null =
                  "icon" in item
                    ? (item.icon as typeof LayoutDashboard)
                    : "kind" in item && item.kind === "order"
                      ? ShoppingBag
                      : "kind" in item && item.kind === "quote"
                        ? FileText
                        : "kind" in item && item.kind === "opportunity"
                          ? TrendingUp
                          : "kind" in item && item.kind === "contact"
                            ? Users
                            : null;
                return (
                  <button
                    key={item.id}
                    onClick={() => selectItem(item)}
                    onMouseEnter={() => setActiveIndex(renderedIndex)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left",
                      isActive ? "bg-accent-50" : "hover:bg-surface-hover",
                    )}
                  >
                    {Icon ? (
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-canvas text-ink-secondary">
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    ) : (
                      <Avatar name={item.title} size="sm" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink-primary">{item.title}</span>
                      {item.subtitle && <span className="block truncate text-xs text-ink-tertiary">{item.subtitle}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-border-subtle bg-canvas px-4 py-2 text-[11px] text-ink-tertiary">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-surface px-1 py-0.5">↑↓</kbd> navigeren
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-surface px-1 py-0.5">↵</kbd> openen
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-surface px-1 py-0.5">esc</kbd> sluiten
          </span>
        </div>
      </div>
    </div>
  );
}

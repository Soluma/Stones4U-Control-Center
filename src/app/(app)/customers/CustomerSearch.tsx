"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";

type SearchResult = {
  shopify: {
    gid: string;
    displayName: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    numberOfOrders: number;
  };
  customerProfileId: string | null;
};

export function CustomerSearch() {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      fetch(`/api/customers/search?q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body.error ?? "Zoeken mislukt.");
          }
          return r.json();
        })
        .then((data) => {
          setResults(data.results ?? []);
          setActiveIndex(0);
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [term]);

  async function openCustomer(result: SearchResult) {
    setOpening(result.shopify.gid);
    const response = await fetch("/api/customers/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopifyGid: result.shopify.gid }),
    });
    const data = await response.json();
    if (data.customerProfileId) router.push(`/customers/${data.customerProfileId}`);
    else setOpening(null);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = results[activeIndex];
      if (target) void openCustomer(target);
    }
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" aria-hidden />
        <input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Zoek op naam, bedrijf, e-mail of telefoonnummer…"
          aria-label="Klanten zoeken"
          className="cc-input py-3 pl-10 text-base"
        />
      </div>

      {error && (
        <EmptyState tone="error" title="Zoeken mislukt" description={error} />
      )}

      {loading && <SkeletonList rows={4} />}

      {!loading && !error && term.trim().length >= 2 && results.length === 0 && (
        <EmptyState
          title="Geen klanten gevonden"
          description="Probeer te zoeken op naam, e-mailadres, telefoonnummer, of bedrijfsnaam."
        />
      )}

      {!loading && term.trim().length < 2 && (
        <EmptyState icon={<Search className="h-5 w-5" />} title="Zoek een klant" description="Typ minimaal 2 tekens om te beginnen met zoeken." />
      )}

      {!loading && results.length > 0 && (
        <div role="listbox" aria-label="Zoekresultaten" className="cc-card divide-y divide-border-subtle overflow-hidden">
          {results.map((result, index) => (
            <button
              key={result.shopify.gid}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => openCustomer(result)}
              onMouseEnter={() => setActiveIndex(index)}
              disabled={opening === result.shopify.gid}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors disabled:opacity-60",
                index === activeIndex ? "bg-accent-50" : "hover:bg-surface-hover",
              )}
            >
              <Avatar name={result.shopify.displayName} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-primary">{result.shopify.displayName}</p>
                <p className="truncate text-xs text-ink-tertiary">
                  {[result.shopify.company, result.shopify.email, result.shopify.phone].filter(Boolean).join(" · ") || "Geen contactgegevens"}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs font-medium tabular-nums text-ink-secondary">{result.shopify.numberOfOrders}</p>
                <p className="text-[10px] text-ink-tertiary">orders</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

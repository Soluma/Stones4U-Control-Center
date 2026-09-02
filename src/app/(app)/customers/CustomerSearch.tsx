"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";

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
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([]);
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
      <input
        autoFocus
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Zoek op naam, bedrijf, e-mail of telefoonnummer…"
        className="cc-input text-base py-3"
      />

      {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      {loading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      )}

      {!loading && term.trim().length >= 2 && results.length === 0 && !error && (
        <EmptyState
          title="Geen klanten gevonden"
          description="Probeer te zoeken op naam, e-mailadres, telefoonnummer, of bedrijfsnaam."
        />
      )}

      {!loading && term.trim().length < 2 && (
        <EmptyState title="Zoek een klant" description="Typ minimaal 2 tekens om te beginnen met zoeken." />
      )}

      {results.length > 0 && (
        <div className="cc-card divide-y divide-border-subtle overflow-hidden">
          {results.map((result, index) => (
            <button
              key={result.shopify.gid}
              ref={(el) => {
                rowRefs.current[index] = el;
              }}
              onClick={() => openCustomer(result)}
              disabled={opening === result.shopify.gid}
              className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors ${
                index === activeIndex ? "bg-accent-50" : "hover:bg-canvas"
              }`}
            >
              <div>
                <p className="text-sm font-medium text-ink-primary">{result.shopify.displayName}</p>
                <p className="text-xs text-ink-tertiary">
                  {[result.shopify.company, result.shopify.email, result.shopify.phone].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-ink-tertiary">{result.shopify.numberOfOrders} orders</span>
                {opening === result.shopify.gid && <span className="text-xs text-ink-tertiary">Openen…</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

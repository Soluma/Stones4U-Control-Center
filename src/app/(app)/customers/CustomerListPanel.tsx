"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { customerDisplayName, customerSecondaryName } from "@/modules/crm/customer-identity";

type Scope = "mine" | "unassigned" | "all";

type CustomerRow = {
  id: string;
  displayName: string | null;
  companyName: string | null;
  customerTypeOverride: "INDIVIDUAL" | "ORGANIZATION" | null;
  crmStatus: string;
  updatedAt: string;
  accountManager: { id: string; name: string; active: boolean } | null;
};

type ListResponse = {
  customers: CustomerRow[];
  total: number;
  counts: Record<Scope, number>;
  scope: Scope;
  page: number;
};

const PAGE_SIZE = 25;

// Phase 6b — local customer list (docs/build/PHASE-6B-MY-CUSTOMERS-STAGING.md).
// Deliberately separate from the existing live-Shopify CustomerSearch above
// it on the page — this panel only ever browses locally-materialized
// CustomerProfile rows, scoped by accountManagerId.
export function CustomerListPanel({ initialScope, canAssign }: { initialScope: Scope; canAssign: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [scope, setScope] = useState<Scope>(initialScope);
  const [term, setTerm] = useState(searchParams.get("q") ?? "");
  const [page, setPage] = useState(Number(searchParams.get("page")) || 1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const syncUrl = useCallback(
    (nextScope: Scope, nextTerm: string, nextPage: number) => {
      const params = new URLSearchParams();
      params.set("scope", nextScope);
      if (nextTerm) params.set("q", nextTerm);
      if (nextPage > 1) params.set("page", String(nextPage));
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname],
  );

  useEffect(() => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => {
        const params = new URLSearchParams({ scope, page: String(page) });
        if (term.trim()) params.set("q", term.trim());
        fetch(`/api/customers?${params.toString()}`, { signal: controller.signal })
          .then(async (r) => {
            if (!r.ok) throw new Error("Laden mislukt.");
            return (await r.json()) as ListResponse;
          })
          .then((json) => {
            setData(json);
            syncUrl(scope, term.trim(), page);
          })
          .catch((e) => {
            if (e.name !== "AbortError") setError(e.message);
          })
          .finally(() => setLoading(false));
      },
      term ? 250 : 0,
    );
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, term, page, refreshKey]);

  function handleScopeChange(next: string) {
    setScope(next as Scope);
    setPage(1);
  }

  function handleTermChange(next: string) {
    setTerm(next);
    setPage(1);
  }

  async function assignToSelf(customerId: string) {
    setAssigning(customerId);
    setAssignError(null);
    const res = await fetch(`/api/customers/${customerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignToSelf: true }),
    });
    setAssigning(null);
    if (res.status === 409) {
      // Someone else claimed this customer between page load and this
      // click (concurrency-safe conditional update on the server, never a
      // silent overwrite) — surface it separately from the list-loading
      // error state, since the refresh below would otherwise clear it
      // immediately.
      const body = await res.json().catch(() => ({}));
      setAssignError(body.error ?? "Deze klant is inmiddels al toegewezen.");
    }
    // Re-fetch the current page/scope/search — the assigned customer leaves
    // the "unassigned" scope, so this row should disappear from the list.
    setRefreshKey((k) => k + 1);
  }

  const tabs: TabItem[] = [
    { key: "mine", label: `Mijn klanten${data ? ` (${data.counts.mine})` : ""}` },
    { key: "unassigned", label: `Niet toegewezen${data ? ` (${data.counts.unassigned})` : ""}` },
    { key: "all", label: `Alle klanten${data ? ` (${data.counts.all})` : ""}` },
  ];

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <Tabs items={tabs} active={scope} onSelect={handleScopeChange} />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" aria-hidden />
        <input
          value={term}
          onChange={(e) => handleTermChange(e.target.value)}
          placeholder="Zoek binnen deze weergave op naam of bedrijf…"
          aria-label="Zoek binnen deze weergave"
          className="cc-input py-2 pl-9 text-sm"
        />
      </div>

      {assignError && (
        <div className="rounded-md border border-warning-500/20 bg-warning-50 px-3 py-2 text-xs text-warning-700">{assignError}</div>
      )}

      {error && <EmptyState tone="error" title="Laden mislukt" description={error} />}

      {loading && <SkeletonList rows={4} />}

      {!loading && !error && data && data.customers.length === 0 && (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title={term.trim() ? "Geen klanten gevonden" : emptyTitle(scope)}
          description={term.trim() ? `Geen resultaten voor "${term.trim()}" in deze weergave.` : emptyDescription(scope)}
        />
      )}

      {!loading && !error && data && data.customers.length > 0 && (
        <div className="cc-card divide-y divide-border-subtle">
          {data.customers.map((customer) => {
            const primary = customerDisplayName(customer);
            const secondary = customerSecondaryName(customer);
            return (
              <div key={customer.id} className="cc-table-row flex items-center gap-3 px-4 py-2.5 text-sm">
                <Link href={`/customers/${customer.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={primary} />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-primary">{primary}</p>
                    <p className="truncate text-xs text-ink-tertiary">
                      {secondary ? `Accounthouder: ${secondary}` : null}
                      {secondary && scope !== "mine" ? " · " : ""}
                      {scope !== "mine" && <AccountManagerLabel accountManager={customer.accountManager} />}
                    </p>
                  </div>
                </Link>
                {scope === "unassigned" && canAssign && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={assigning === customer.id}
                    onClick={() => assignToSelf(customer.id)}
                    className="shrink-0"
                  >
                    Aan mij toewijzen
                  </Button>
                )}
                <span className="shrink-0 text-xs text-ink-tertiary">{formatDate(customer.updatedAt)}</span>
              </div>
            );
          })}
        </div>
      )}

      {!loading && data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-ink-tertiary">
          <span>
            Pagina {page} van {totalPages} · {data.total} klanten
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className={cn("cc-btn-secondary px-2 py-1", page <= 1 && "opacity-50")}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className={cn("cc-btn-secondary px-2 py-1", page >= totalPages && "opacity-50")}
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountManagerLabel({ accountManager }: { accountManager: { name: string; active: boolean } | null }) {
  if (!accountManager) return <span>Niet toegewezen</span>;
  return (
    <span>
      Accountmanager: {accountManager.name}
      {!accountManager.active && <Badge tone="neutral" className="ml-1">inactief</Badge>}
    </span>
  );
}

function emptyTitle(scope: Scope): string {
  if (scope === "mine") return "Nog geen klanten toegewezen";
  if (scope === "unassigned") return "Alle klanten zijn toegewezen";
  return "Nog geen klanten bekend";
}

function emptyDescription(scope: Scope): string {
  if (scope === "mine") return "Je hebt nog geen klanten als accountmanager toegewezen gekregen.";
  if (scope === "unassigned") return "Er zijn momenteel geen klanten zonder accountmanager.";
  return "Klanten verschijnen hier zodra ze via zoeken zijn geopend.";
}

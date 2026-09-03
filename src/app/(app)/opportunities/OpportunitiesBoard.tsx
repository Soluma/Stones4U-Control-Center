"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Search, LayoutGrid, List as ListIcon, TrendingUp, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { formatDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/cn";
import { STAGE_ORDER, STAGE_LABEL, STATUS_LABEL, effectiveProbability, type OpportunityStageCode } from "@/modules/opportunities/labels";
import { NewOpportunityDialog } from "./NewOpportunityDialog";

type OpportunityRow = {
  id: string;
  title: string;
  stage: OpportunityStageCode;
  status: "OPEN" | "WON" | "LOST";
  estimatedValue: string | null;
  probability: number | null;
  expectedCloseDate: string | null;
  archivedAt: string | null;
  customerProfile: { id: string; displayName: string | null; companyName: string | null };
  owner: { id: string; name: string };
  tasks: { id: string; title: string; dueAt: string | null }[];
  needsFollowUp: boolean;
};

type AssignableUser = { id: string; name: string };

function customerName(customerProfile: OpportunityRow["customerProfile"]) {
  return customerProfile.displayName ?? customerProfile.companyName ?? "Klant";
}

function OpportunityCard({ opportunity }: { opportunity: OpportunityRow }) {
  const nextTask = opportunity.tasks[0];
  return (
    <Link
      href={`/opportunities/${opportunity.id}`}
      className="block rounded-lg border border-border-subtle bg-surface p-3 text-sm shadow-sm transition hover:border-accent-500/40 hover:shadow-md"
    >
      <p className="truncate font-medium text-ink-primary">{opportunity.title}</p>
      <p className="mt-0.5 truncate text-xs text-ink-tertiary">{customerName(opportunity.customerProfile)}</p>
      <div className="mt-2 flex items-center justify-between text-xs text-ink-secondary">
        <span className="font-medium tabular-nums">{formatMoney(opportunity.estimatedValue ? { amount: opportunity.estimatedValue, currencyCode: "EUR" } : null)}</span>
        <span>{effectiveProbability(opportunity)}%</span>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-ink-tertiary">
        <span className="truncate">{opportunity.owner.name}</span>
        {opportunity.expectedCloseDate && <span className="shrink-0">{formatDate(opportunity.expectedCloseDate)}</span>}
      </div>
      {nextTask && (
        <p className="mt-1.5 truncate border-t border-border-subtle pt-1.5 text-[11px] text-ink-tertiary">
          Volgende actie: {nextTask.title}
        </p>
      )}
      {opportunity.needsFollowUp && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-warning-700">
          <AlertTriangle className="h-3 w-3" aria-hidden /> Opvolging nodig
        </p>
      )}
    </Link>
  );
}

export function OpportunitiesBoard({ canCreate }: { canCreate: boolean }) {
  const [opportunities, setOpportunities] = useState<OpportunityRow[] | null>(null);
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [status, setStatus] = useState<"OPEN" | "WON" | "LOST" | "ALL">("OPEN");
  const [stage, setStage] = useState<OpportunityStageCode | "">("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState<"exclude" | "only">("exclude");
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const refresh = useCallback(async () => {
    setOpportunities(null);
    const params = new URLSearchParams();
    params.set("status", view === "kanban" ? "OPEN" : status);
    if (stage) params.set("stage", stage);
    if (ownerUserId) params.set("ownerUserId", ownerUserId);
    if (search.trim()) params.set("search", search.trim());
    params.set("archived", archived);

    const response = await fetch(`/api/opportunities?${params.toString()}`);
    const data = await response.json();
    setOpportunities(data.opportunities ?? []);
  }, [view, status, stage, ownerUserId, search, archived]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    fetch("/api/users/assignable")
      .then((r) => r.json())
      .then((data) => setUsers(data.users ?? []));
  }, []);

  const grouped: Record<OpportunityStageCode, OpportunityRow[]> = Object.fromEntries(
    STAGE_ORDER.map((s) => [s, (opportunities ?? []).filter((o) => o.stage === s)]),
  ) as Record<OpportunityStageCode, OpportunityRow[]>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-md border border-border-subtle p-0.5">
          <button
            onClick={() => setView("kanban")}
            className={cn("flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium", view === "kanban" ? "bg-accent-50 text-accent-700" : "text-ink-tertiary hover:text-ink-primary")}
          >
            <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> Kanban
          </button>
          <button
            onClick={() => setView("list")}
            className={cn("flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium", view === "list" ? "bg-accent-50 text-accent-700" : "text-ink-tertiary hover:text-ink-primary")}
          >
            <ListIcon className="h-3.5 w-3.5" aria-hidden /> Lijst
          </button>
        </div>
        {canCreate && (
          <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialogOpen(true)}>
            Nieuwe verkoopkans
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Zoek op titel of klant…"
            className="cc-input py-1.5 pl-8 text-sm"
          />
        </div>
        {view === "list" && (
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="cc-input w-auto py-1.5 text-sm">
            <option value="OPEN">Status: open</option>
            <option value="WON">Status: gewonnen</option>
            <option value="LOST">Status: verloren</option>
            <option value="ALL">Status: alle</option>
          </select>
        )}
        <select value={stage} onChange={(e) => setStage(e.target.value as OpportunityStageCode | "")} className="cc-input w-auto py-1.5 text-sm">
          <option value="">Alle fases</option>
          {STAGE_ORDER.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} className="cc-input w-auto py-1.5 text-sm">
          <option value="">Alle eigenaren</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select value={archived} onChange={(e) => setArchived(e.target.value as typeof archived)} className="cc-input w-auto py-1.5 text-sm">
          <option value="exclude">Actief</option>
          <option value="only">Gearchiveerd</option>
        </select>
      </div>

      {opportunities === null && <SkeletonList rows={4} />}

      {opportunities !== null && opportunities.length === 0 && (
        <EmptyState icon={<TrendingUp className="h-5 w-5" />} title="Geen verkoopkansen" description="Er zijn hier geen verkoopkansen te tonen met de huidige filters." />
      )}

      {opportunities !== null && opportunities.length > 0 && view === "kanban" && (
        <div className="grid grid-cols-1 gap-3 overflow-x-auto sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {STAGE_ORDER.map((s) => (
            <div key={s} className="min-w-0">
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-xs font-semibold text-ink-secondary">{STAGE_LABEL[s]}</p>
                <span className="text-xs text-ink-tertiary">{grouped[s]!.length}</span>
              </div>
              <div className="space-y-2">
                {grouped[s]!.map((opportunity) => (
                  <OpportunityCard key={opportunity.id} opportunity={opportunity} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {opportunities !== null && opportunities.length > 0 && view === "list" && (
        <div className="cc-card divide-y divide-border-subtle">
          {opportunities.map((opportunity) => (
            <Link
              key={opportunity.id}
              href={`/opportunities/${opportunity.id}`}
              className="cc-table-row flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-primary">{opportunity.title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-tertiary">
                  <span>{customerName(opportunity.customerProfile)}</span>
                  <span>·</span>
                  <span>{STAGE_LABEL[opportunity.stage]}</span>
                  <span>·</span>
                  <span>{opportunity.owner.name}</span>
                  {opportunity.expectedCloseDate && (
                    <>
                      <span>·</span>
                      <span>{formatDate(opportunity.expectedCloseDate)}</span>
                    </>
                  )}
                  {opportunity.needsFollowUp && (
                    <>
                      <span>·</span>
                      <span className="font-medium text-warning-700">Opvolging nodig</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-sm font-medium tabular-nums text-ink-secondary">
                  {formatMoney(opportunity.estimatedValue ? { amount: opportunity.estimatedValue, currencyCode: "EUR" } : null)}
                </span>
                <Badge tone={opportunity.status === "WON" ? "success" : opportunity.status === "LOST" ? "danger" : "neutral"}>
                  {STATUS_LABEL[opportunity.status]}
                </Badge>
              </div>
            </Link>
          ))}
        </div>
      )}

      <NewOpportunityDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={refresh} />
    </div>
  );
}

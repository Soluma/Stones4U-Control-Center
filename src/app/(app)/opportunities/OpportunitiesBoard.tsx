"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search, LayoutGrid, List as ListIcon, TrendingUp, X } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { formatDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/cn";
import { STAGE_ORDER, STAGE_LABEL, STATUS_LABEL, effectiveProbability, type OpportunityStageCode } from "@/modules/opportunities/labels";
import { formatNextAction, type OpportunityAttention, type NextActionInfo } from "@/modules/opportunities/attention";
import { AttentionBadge } from "./AttentionBadge";
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
  attention: OpportunityAttention;
  nextAction: NextActionInfo;
};

type AssignableUser = { id: string; name: string };

function customerName(customerProfile: OpportunityRow["customerProfile"]) {
  return customerProfile.displayName ?? customerProfile.companyName ?? "Klant";
}

function nextActionText(nextAction: NextActionInfo): string {
  return formatNextAction(nextAction, (d) => formatDate(d));
}

function OpportunityCardContent({ opportunity }: { opportunity: OpportunityRow }) {
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate font-medium text-ink-primary">{opportunity.title}</p>
        <AttentionBadge severity={opportunity.attention.severity} primaryReason={opportunity.attention.primaryReason} compact />
      </div>
      <p className="mt-0.5 truncate text-xs text-ink-tertiary">{customerName(opportunity.customerProfile)}</p>
      <div className="mt-2 flex items-center justify-between text-xs text-ink-secondary">
        <span className="font-medium tabular-nums">{formatMoney(opportunity.estimatedValue ? { amount: opportunity.estimatedValue, currencyCode: "EUR" } : null)}</span>
        <span>{effectiveProbability(opportunity)}%</span>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-ink-tertiary">
        <span className="truncate">{opportunity.owner.name}</span>
        {opportunity.expectedCloseDate && <span className="shrink-0">{formatDate(opportunity.expectedCloseDate)}</span>}
      </div>
      <p
        className={cn(
          "mt-1.5 truncate border-t border-border-subtle pt-1.5 text-[11px]",
          opportunity.nextAction.state === "OVERDUE" ? "font-medium text-danger-500" : "text-ink-tertiary",
        )}
      >
        {nextActionText(opportunity.nextAction)}
      </p>
    </>
  );
}

/** Draggable card — pointer + keyboard (dnd-kit's default sensors). The
 * stage dropdown on the detail page remains the guaranteed, fully
 * keyboard-operable alternative regardless of how well drag itself works
 * for a given input method (architecture doc §10). */
function DraggableOpportunityCard({ opportunity, disabled }: { opportunity: OpportunityRow; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: opportunity.id,
    disabled,
    data: { stage: opportunity.stage },
  });

  return (
    <div
      ref={setNodeRef}
      {...(disabled ? {} : { ...listeners, ...attributes })}
      className={cn(
        "rounded-lg border border-border-subtle bg-surface p-3 text-sm shadow-sm transition",
        !disabled && "cursor-grab active:cursor-grabbing hover:border-accent-500/40 hover:shadow-md",
        isDragging && "opacity-40",
      )}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 10, position: "relative" } : undefined}
    >
      <Link href={`/opportunities/${opportunity.id}`} className="block" onClick={(e) => isDragging && e.preventDefault()}>
        <OpportunityCardContent opportunity={opportunity} />
      </Link>
    </div>
  );
}

function DroppableStageColumn({
  stage,
  children,
  count,
}: {
  stage: OpportunityStageCode;
  children: React.ReactNode;
  count: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-xs font-semibold text-ink-secondary">{STAGE_LABEL[stage]}</p>
        <span className="text-xs text-ink-tertiary">{count}</span>
      </div>
      <div ref={setNodeRef} className={cn("min-h-[3rem] space-y-2 rounded-lg", isOver && "bg-accent-50/60 outline-dashed outline-2 outline-accent-300")}>
        {children}
      </div>
    </div>
  );
}

export function OpportunitiesBoard({
  canCreate,
  canEdit,
  currentUserId,
  isAdmin,
}: {
  canCreate: boolean;
  canEdit: boolean;
  currentUserId: string;
  isAdmin: boolean;
}) {
  const [opportunities, setOpportunities] = useState<OpportunityRow[] | null>(null);
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [status, setStatus] = useState<"OPEN" | "WON" | "LOST" | "ALL">("OPEN");
  const [stage, setStage] = useState<OpportunityStageCode | "">("");
  // Non-admins default to "my own pipeline" (architecture doc §12/§14) —
  // still freely switchable to any other value, no extra RBAC layer:
  // reading someone else's opportunity list was never treated as a write.
  const [ownerUserId, setOwnerUserId] = useState(isAdmin ? "" : currentUserId);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState<"exclude" | "only">("exclude");
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dragErrorId, setDragErrorId] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

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

  const activeDragCard = useMemo(() => opportunities?.find((o) => o.id === activeDragId) ?? null, [opportunities, activeDragId]);

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const opportunityId = String(active.id);
    const newStage = String(over.id) as OpportunityStageCode;
    const current = opportunities?.find((o) => o.id === opportunityId);
    if (!current || current.stage === newStage) return;

    const previousStage = current.stage;
    setOpportunities((prev) => prev!.map((o) => (o.id === opportunityId ? { ...o, stage: newStage } : o)));
    setDragErrorId(null);

    try {
      const response = await fetch(`/api/opportunities/${opportunityId}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: newStage }),
      });
      if (!response.ok) {
        setOpportunities((prev) => prev!.map((o) => (o.id === opportunityId ? { ...o, stage: previousStage } : o)));
        setDragErrorId(opportunityId);
      } else {
        // Attention/next-action can shift as a side effect of a stage
        // change (a new stage has a different stale threshold) — a light
        // refresh keeps that honest rather than showing stale derived data.
        void refresh();
      }
    } catch {
      setOpportunities((prev) => prev!.map((o) => (o.id === opportunityId ? { ...o, stage: previousStage } : o)));
      setDragErrorId(opportunityId);
    }
  }

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
          <option value={currentUserId}>Mijn verkoopkansen</option>
          {users.filter((u) => u.id !== currentUserId).map((u) => (
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

      {dragErrorId && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-danger-500/20 bg-danger-50 px-3 py-2 text-sm text-danger-700">
          <span>Fase wijzigen is mislukt — de kaart is teruggezet naar de oorspronkelijke kolom.</span>
          <button onClick={() => setDragErrorId(null)} className="shrink-0 text-danger-700 hover:text-danger-900">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}

      {opportunities === null && <SkeletonList rows={4} />}

      {opportunities !== null && opportunities.length === 0 && (
        <EmptyState icon={<TrendingUp className="h-5 w-5" />} title="Geen verkoopkansen" description="Er zijn hier geen verkoopkansen te tonen met de huidige filters." />
      )}

      {opportunities !== null && opportunities.length > 0 && view === "kanban" && (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-1 gap-3 overflow-x-auto sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {STAGE_ORDER.map((s) => (
              <DroppableStageColumn key={s} stage={s} count={grouped[s]!.length}>
                {grouped[s]!.map((opportunity) => (
                  <DraggableOpportunityCard key={opportunity.id} opportunity={opportunity} disabled={!canEdit} />
                ))}
              </DroppableStageColumn>
            ))}
          </div>
          <DragOverlay>
            {activeDragCard ? (
              <div className="w-64 rounded-lg border border-accent-500/40 bg-surface p-3 text-sm shadow-lg">
                <OpportunityCardContent opportunity={activeDragCard} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {opportunities !== null && opportunities.length > 0 && view === "list" && (
        <div className="cc-card overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs text-ink-tertiary">
                <th className="px-4 py-2.5 font-medium">Verkoopkans</th>
                <th className="px-4 py-2.5 font-medium">Klant</th>
                <th className="px-4 py-2.5 font-medium">Fase</th>
                <th className="px-4 py-2.5 text-right font-medium">Waarde</th>
                <th className="px-4 py-2.5 text-right font-medium">Kans</th>
                <th className="px-4 py-2.5 font-medium">Eigenaar</th>
                <th className="px-4 py-2.5 font-medium">Sluitdatum</th>
                <th className="px-4 py-2.5 font-medium">Volgende actie</th>
                <th className="px-4 py-2.5 font-medium">Aandacht</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {opportunities.map((opportunity) => (
                <tr key={opportunity.id} className="cc-table-row">
                  <td className="max-w-[220px] px-4 py-2.5">
                    <Link href={`/opportunities/${opportunity.id}`} className="block truncate font-medium text-ink-primary hover:underline">
                      {opportunity.title}
                    </Link>
                  </td>
                  <td className="max-w-[160px] truncate px-4 py-2.5 text-ink-secondary">{customerName(opportunity.customerProfile)}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">{STAGE_LABEL[opportunity.stage]}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums text-ink-primary">
                    {formatMoney(opportunity.estimatedValue ? { amount: opportunity.estimatedValue, currencyCode: "EUR" } : null)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{effectiveProbability(opportunity)}%</td>
                  <td className="max-w-[120px] truncate px-4 py-2.5 text-ink-secondary">{opportunity.owner.name}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">{formatDate(opportunity.expectedCloseDate)}</td>
                  <td className={cn("max-w-[180px] truncate px-4 py-2.5", opportunity.nextAction.state === "OVERDUE" ? "font-medium text-danger-500" : "text-ink-secondary")}>
                    {nextActionText(opportunity.nextAction)}
                  </td>
                  <td className="px-4 py-2.5">
                    {opportunity.status !== "OPEN" ? (
                      <Badge tone={opportunity.status === "WON" ? "success" : "danger"}>{STATUS_LABEL[opportunity.status]}</Badge>
                    ) : (
                      <AttentionBadge severity={opportunity.attention.severity} primaryReason={opportunity.attention.primaryReason} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <NewOpportunityDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={refresh} />
    </div>
  );
}

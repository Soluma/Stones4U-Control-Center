"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { formatDate, formatMoney } from "@/lib/format";
import { STAGE_LABEL, STATUS_LABEL, effectiveProbability, type OpportunityStageCode } from "@/modules/opportunities/labels";
import type { OpportunityAttention } from "@/modules/opportunities/attention";
import { NewOpportunityDialog } from "../../opportunities/NewOpportunityDialog";
import { AttentionBadge } from "../../opportunities/AttentionBadge";

type OpportunityRow = {
  id: string;
  title: string;
  stage: OpportunityStageCode;
  status: "OPEN" | "WON" | "LOST";
  estimatedValue: string | null;
  probability: number | null;
  expectedCloseDate: string | null;
  attention: OpportunityAttention;
};

// Customer 360 Commercieel-tab section — no new top-level tab (architecture
// doc §9), a section alongside Bestellingen/Conceptbestellingen/Offertes.
export function OpportunitiesSection({
  customerId,
  customerName,
  canCreate,
}: {
  customerId: string;
  customerName: string;
  canCreate: boolean;
}) {
  const [opportunities, setOpportunities] = useState<OpportunityRow[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/customers/${customerId}/opportunities`);
    const data = await response.json();
    setOpportunities(data.opportunities ?? []);
  }, [customerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink-secondary">Verkoopkansen</h2>
        {canCreate && (
          <Button variant="secondary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialogOpen(true)}>
            Nieuwe verkoopkans
          </Button>
        )}
      </div>

      {opportunities === null && <SkeletonList rows={2} />}
      {opportunities !== null && opportunities.length === 0 && (
        <EmptyState icon={<TrendingUp className="h-5 w-5" />} title="Geen verkoopkansen" description="Er zijn nog geen verkoopkansen voor deze klant." />
      )}

      {opportunities !== null && opportunities.length > 0 && (
        <div className="cc-card divide-y divide-border-subtle">
          {opportunities.map((opportunity) => (
            <Link key={opportunity.id} href={`/opportunities/${opportunity.id}`} className="cc-table-row flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="truncate font-medium text-ink-primary">{opportunity.title}</p>
                  <AttentionBadge severity={opportunity.attention.severity} primaryReason={opportunity.attention.primaryReason} compact />
                </div>
                <p className="mt-0.5 truncate text-xs text-ink-tertiary">
                  {STAGE_LABEL[opportunity.stage]} · {effectiveProbability(opportunity)}%
                  {opportunity.expectedCloseDate ? ` · ${formatDate(opportunity.expectedCloseDate)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="font-medium tabular-nums text-ink-secondary">
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

      <NewOpportunityDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={refresh}
        fixedCustomer={{ customerProfileId: customerId, name: customerName }}
      />
    </div>
  );
}

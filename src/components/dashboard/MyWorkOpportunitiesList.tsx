import Link from "next/link";
import { TrendingUp } from "lucide-react";
import { formatDate } from "@/lib/format";
import { customerDisplayName } from "@/modules/crm/customer-identity";
import { STAGE_LABEL } from "@/modules/opportunities/labels";
import { formatNextAction } from "@/modules/opportunities/attention";
import { AttentionBadge } from "@/app/(app)/opportunities/AttentionBadge";
import type { MyWorkOpportunity } from "@/modules/dashboard/my-work";

export function MyWorkOpportunitiesList({ opportunities }: { opportunities: MyWorkOpportunity[] }) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium text-ink-secondary">Verkoopkansen</h3>
      {opportunities.length === 0 ? (
        <p className="cc-card p-4 text-sm text-ink-tertiary">Geen verkoopkansen die aandacht nodig hebben.</p>
      ) : (
        <div className="cc-card divide-y divide-border-subtle">
          {opportunities.map((opportunity) => (
            <Link key={opportunity.id} href={`/opportunities/${opportunity.id}`} className="cc-table-row flex items-center gap-3 px-4 py-2.5 text-sm">
              <TrendingUp className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-ink-primary">{opportunity.title}</span>
                  <AttentionBadge severity={opportunity.attention.severity} primaryReason={opportunity.attention.primaryReason} compact />
                </span>
                <span className="block truncate text-xs text-ink-tertiary">
                  {customerDisplayName(opportunity.customerProfile)} · {STAGE_LABEL[opportunity.stage]} ·{" "}
                  {formatNextAction(opportunity.nextAction, formatDate)}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

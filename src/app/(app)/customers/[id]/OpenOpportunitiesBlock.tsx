import Link from "next/link";
import { TrendingUp } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/format";
import { STAGE_LABEL, effectiveProbability, type OpportunityStageCode } from "@/modules/opportunities/labels";

type OpportunitySummary = {
  id: string;
  title: string;
  stage: OpportunityStageCode;
  estimatedValue: string | null;
  probability: number | null;
  expectedCloseDate: string | null;
};

// Overview-tab compact block, same visual pattern as RecentCallsBlock/
// RecentEmailsBlock — a customer with multiple concurrent opportunities
// must stay legible: every open opportunity is listed individually, never
// collapsed into one row (architecture doc §9).
export function OpenOpportunitiesBlock({ opportunities }: { opportunities: OpportunitySummary[] }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-ink-secondary">Open verkoopkansen</h2>
      {opportunities.length === 0 ? (
        <p className="cc-card p-4 text-sm text-ink-tertiary">Geen open verkoopkansen voor deze klant.</p>
      ) : (
        <div className="cc-card divide-y divide-border-subtle">
          {opportunities.map((opportunity) => (
            <Link key={opportunity.id} href={`/opportunities/${opportunity.id}`} className="cc-table-row flex items-center gap-3 px-4 py-2.5 text-sm">
              <TrendingUp className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" aria-hidden />
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink-primary">{opportunity.title}</span>
                <span className="block truncate text-xs text-ink-tertiary">
                  {STAGE_LABEL[opportunity.stage]} · {effectiveProbability(opportunity)}%
                  {opportunity.expectedCloseDate ? ` · ${formatDate(opportunity.expectedCloseDate)}` : ""}
                </span>
              </div>
              <span className="shrink-0 text-xs font-medium tabular-nums text-ink-secondary">
                {formatMoney(opportunity.estimatedValue ? { amount: opportunity.estimatedValue, currencyCode: "EUR" } : null)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { StickyNote, CheckSquare } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { formatDate, formatMoney } from "@/lib/format";
import { CrmStatusControl } from "./CrmStatusControl";
import type { Customer360 } from "@/modules/crm/customer-profile.service";
import type { Role } from "@/generated/prisma";

export function CustomerHeader({ data, viewerRole, id }: { data: Customer360; viewerRole: Role; id: string }) {
  const { profile, shopify, orders } = data;
  const canEdit = viewerRole !== "VIEWER";

  return (
    <div className="cc-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={shopify.displayName} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight text-ink-primary">{shopify.displayName}</h1>
              <CrmStatusControl customerProfileId={profile.id} status={profile.crmStatus} canEdit={canEdit} />
            </div>
            <p className="mt-1 text-sm text-ink-tertiary">
              {[shopify.company, shopify.email, shopify.phone, shopify.defaultAddressSummary].filter(Boolean).join(" · ") ||
                "Geen contactgegevens bekend"}
            </p>
            {profile.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {profile.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-right sm:grid-cols-4">
          <Metric label="Orders" value={String(orders.totalOrders)} />
          <Metric label="Omzet" value={formatMoney(orders.totalSpent)} />
          <Metric
            label="Openstaand"
            value={String(orders.outstandingOrders)}
            tone={orders.outstandingOrders > 0 ? "warning" : undefined}
          />
          <Metric label="Laatste order" value={formatDate(orders.lastOrderAt)} />
        </dl>
      </div>

      {canEdit && (
        <div className="mt-4 flex gap-2 border-t border-border-subtle pt-4">
          <Link href={`/customers/${id}?tab=notes`} className="cc-btn-secondary">
            <StickyNote className="h-3.5 w-3.5" aria-hidden />
            Notitie toevoegen
          </Link>
          <Link href={`/customers/${id}?tab=tasks`} className="cc-btn-secondary">
            <CheckSquare className="h-3.5 w-3.5" aria-hidden />
            Taak toevoegen
          </Link>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
  return (
    <div>
      <dt className="text-xs text-ink-tertiary">{label}</dt>
      <dd className={`text-sm font-semibold tabular-nums ${tone === "warning" ? "text-warning-700" : "text-ink-primary"}`}>
        {value}
      </dd>
    </div>
  );
}

import Link from "next/link";
import { StickyNote, CheckSquare, CalendarPlus, Paperclip } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { formatDate, formatMoney } from "@/lib/format";
import { CrmStatusControl } from "./CrmStatusControl";
import { AccountManagerControl } from "./AccountManagerControl";
import { CustomerTagsControl } from "./CustomerTagsControl";
import type { Customer360 } from "@/modules/crm/customer-profile.service";
import type { Role } from "@/generated/prisma";

type TagOption = { id: string; name: string; color: string | null };

export function CustomerHeader({
  data,
  viewerRole,
  id,
  tags,
  allTags,
  managers,
}: {
  data: Customer360;
  viewerRole: Role;
  id: string;
  tags: TagOption[];
  allTags: TagOption[];
  managers: { id: string; name: string }[];
}) {
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
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-ink-tertiary">
                <span>Accountmanager:</span>
                <AccountManagerControl customerProfileId={profile.id} currentManagerId={profile.accountManagerId} managers={managers} canEdit={canEdit} />
              </div>
            </div>
            <div className="mt-2">
              <CustomerTagsControl customerProfileId={profile.id} assignedTags={tags} allTags={allTags} canEdit={canEdit} />
            </div>
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
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border-subtle pt-4">
          <Link href={`/customers/${id}?tab=notes`} className="cc-btn-secondary">
            <StickyNote className="h-3.5 w-3.5" aria-hidden />
            Notitie
          </Link>
          <Link href={`/customers/${id}?tab=tasks`} className="cc-btn-secondary">
            <CheckSquare className="h-3.5 w-3.5" aria-hidden />
            Taak
          </Link>
          <Link href={`/customers/${id}?tab=appointments`} className="cc-btn-secondary">
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden />
            Afspraak
          </Link>
          <Link href={`/customers/${id}?tab=files`} className="cc-btn-secondary">
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
            Bestand
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

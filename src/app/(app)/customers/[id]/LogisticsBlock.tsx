import Link from "next/link";
import { Lock, Warehouse } from "lucide-react";
import { formatDate, formatDateTime } from "@/lib/format";
import type { OrderLogisticsSummary } from "@/integrations/logistics/types";
import { eventLabel, handoffLabel, needsAttention, scheduleDisplay, statusLabel } from "@/modules/logistics/presentation";

/**
 * "Logistiek" on the customer card — what the warehouse is doing for this
 * customer right now, at a glance.
 *
 * Deliberately compact: orders that still need something come first, a
 * finished order shrinks to one line, and individual scans, photos, lock
 * history and audit detail stay on the order page where they belong.
 */

const MAX_ORDERS = 5;

export function LogisticsBlock({
  customerId,
  orders,
  unavailable,
}: {
  customerId: string;
  orders: OrderLogisticsSummary[];
  /** OfferteApp did not answer — never rendered as "nothing to do". */
  unavailable: boolean;
}) {
  const sorted = [...orders].sort((a, b) => {
    const attention = Number(needsAttention(b)) - Number(needsAttention(a));
    if (attention !== 0) return attention;
    return (b.orderCreatedAt ?? "").localeCompare(a.orderCreatedAt ?? "");
  });
  const shown = sorted.slice(0, MAX_ORDERS);

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-ink-secondary">Logistiek</h2>
      {unavailable ? (
        <p className="cc-card p-4 text-sm text-ink-tertiary">Logistieke gegevens tijdelijk niet beschikbaar.</p>
      ) : shown.length === 0 ? (
        <p className="cc-card p-4 text-sm text-ink-tertiary">Geen orders in het magazijn.</p>
      ) : (
        <div className="cc-card divide-y divide-border-subtle">
          {shown.map((order) => (
            <OrderRow key={order.shopifyOrderId} customerId={customerId} order={order} />
          ))}
          {sorted.length > shown.length && (
            <Link
              href={`/customers/${customerId}?tab=orders`}
              className="cc-table-row block px-4 py-2 text-xs text-ink-tertiary hover:text-ink-primary"
            >
              Nog {sorted.length - shown.length} andere {sorted.length - shown.length === 1 ? "order" : "orders"} — bekijk Commercieel
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function OrderRow({ customerId, order }: { customerId: string; order: OrderLogisticsSummary }) {
  const schedule = scheduleDisplay(order.scheduleState, order.requestedDate);
  const active = needsAttention(order);

  return (
    <Link href={`/customers/${customerId}/orders/${order.shopifyOrderId}`} className="cc-table-row block px-4 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-ink-primary">
          <Warehouse className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden />
          {order.orderName}
        </span>
        <span className="text-sm text-ink-secondary">{statusLabel(order.operationalStatus)}</span>
      </div>
      <p className="mt-0.5 text-xs text-ink-secondary">
        <span className={order.handoffType === "UNKNOWN" ? "text-ink-tertiary" : undefined}>{handoffLabel(order.handoffType)}</span>
        {" · "}
        <span className={schedule.primary === "Nog geen datum" ? "text-ink-tertiary" : undefined}>{schedule.primary}</span>
        {schedule.secondary ? ` · ${schedule.secondary}` : ""}
      </p>
      {order.lock.active && (
        <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-warning-700">
          <Lock className="h-3 w-3" aria-hidden />
          {order.lock.claimedByName ? `Wordt nu gepickt door ${order.lock.claimedByName}` : "Wordt nu gepickt"}
        </p>
      )}
      <p className="mt-0.5 text-xs tabular-nums text-ink-tertiary">
        {active || !order.pick.completed
          ? `${order.pick.pickedLines} / ${order.pick.totalLines} regels gepickt`
          : order.pick.completedAt
            ? `Gepickt ${formatDate(order.pick.completedAt)}`
            : "Gepickt"}
        {order.pallets.total > 0 ? ` · ${order.pallets.scanned} / ${order.pallets.total} pallets gescand` : ""}
      </p>
      {/* The batch endpoint carries the last event, so a summary line never
          costs a per-order detail call. */}
      {order.lastEvent && (
        <p className="mt-0.5 text-xs text-ink-tertiary">
          {eventLabel(order.lastEvent)} · {formatDateTime(order.lastEvent.occurredAt)}
          {order.lastEvent.actorName ? ` · ${order.lastEvent.actorName}` : ""}
        </p>
      )}
    </Link>
  );
}

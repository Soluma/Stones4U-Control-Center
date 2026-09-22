import Link from "next/link";
import { ShoppingBag, ExternalLink, Lock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { formatDate, formatMoney } from "@/lib/format";
import type { ShopifyOrderSummary } from "@/integrations/shopify/types";
import { legacyOrderId } from "@/integrations/logistics/adapter";
import type { OrderLogisticsSummary } from "@/integrations/logistics/types";
import { handoffLabel, scheduleDisplay, statusLabel } from "@/modules/logistics/presentation";

const FINANCIAL_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  PAID: "success",
  PENDING: "warning",
  PARTIALLY_PAID: "warning",
  AUTHORIZED: "warning",
  REFUNDED: "neutral",
  VOIDED: "danger",
};

/** Logistics as this table needs it: the summaries keyed by Shopify order
 * id, plus whether OfferteApp answered at all. `unavailable` is not the
 * same as an order without logistics data, and the table says so. */
export type OrdersTableLogistics = {
  byOrderId: Map<string, OrderLogisticsSummary>;
  unavailable: boolean;
};

export function OrdersTable({
  orders,
  customerId,
  logistics,
}: {
  orders: ShopifyOrderSummary[];
  /** Set on the customer's own page, where each order has a detail page. */
  customerId?: string;
  logistics?: OrdersTableLogistics | null;
}) {
  if (orders.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag className="h-5 w-5" />}
        title="Geen orders"
        description="Deze klant heeft nog geen Shopify-bestellingen."
      />
    );
  }

  const showLogistics = !!logistics;

  return (
    <div className="space-y-2">
      <Table>
        <TableHead>
          <TableHeaderCell>Order</TableHeaderCell>
          <TableHeaderCell>Datum</TableHeaderCell>
          <TableHeaderCell>Betaalstatus</TableHeaderCell>
          {showLogistics ? (
            <>
              <TableHeaderCell>Afhandeling</TableHeaderCell>
              <TableHeaderCell>Magazijn</TableHeaderCell>
            </>
          ) : (
            <TableHeaderCell>Fulfillment</TableHeaderCell>
          )}
          <TableHeaderCell className="text-right">Totaal</TableHeaderCell>
          <TableHeaderCell className="w-8">
            <span className="sr-only">Acties</span>
          </TableHeaderCell>
        </TableHead>
        <TableBody>
          {orders.map((order) => {
            const legacyId = legacyOrderId(order.gid);
            const item = legacyId ? logistics?.byOrderId.get(legacyId) : undefined;
            return (
              <TableRow key={order.gid}>
                <TableCell className="font-medium text-ink-primary">
                  {customerId && legacyId ? (
                    <Link href={`/customers/${customerId}/orders/${legacyId}`} className="cc-focus-ring hover:text-accent-700">
                      {order.name}
                    </Link>
                  ) : (
                    order.name
                  )}
                </TableCell>
                <TableCell className="text-ink-secondary">{formatDate(order.createdAt)}</TableCell>
                <TableCell>
                  {order.displayFinancialStatus ? (
                    <Badge tone={FINANCIAL_TONE[order.displayFinancialStatus] ?? "neutral"}>{order.displayFinancialStatus}</Badge>
                  ) : (
                    "—"
                  )}
                </TableCell>
                {showLogistics ? (
                  <>
                    <TableCell className="align-top">
                      <HandoffCell item={item} unavailable={logistics.unavailable} />
                    </TableCell>
                    <TableCell className="align-top">
                      <WarehouseCell item={item} unavailable={logistics.unavailable} />
                    </TableCell>
                  </>
                ) : (
                  <TableCell className="text-ink-secondary">{order.displayFulfillmentStatus ?? "—"}</TableCell>
                )}
                <TableCell className="text-right font-medium tabular-nums text-ink-primary">
                  {formatMoney(order.currentTotalPriceSet)}
                </TableCell>
                <TableCell>
                  <a
                    href={order.adminUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center justify-center text-ink-tertiary hover:text-ink-secondary"
                    title="Openen in Shopify Admin"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {logistics?.unavailable && (
        <p className="text-xs text-ink-tertiary">
          Logistieke gegevens tijdelijk niet beschikbaar — de kolommen Afhandeling en Magazijn zijn daarom leeg.
        </p>
      )}
    </div>
  );
}

function HandoffCell({ item, unavailable }: { item: OrderLogisticsSummary | undefined; unavailable: boolean }) {
  if (!item) return <Unknown unavailable={unavailable} />;
  const schedule = scheduleDisplay(item.scheduleState, item.requestedDate);
  return (
    <div className="space-y-0.5">
      <p className={item.handoffType === "UNKNOWN" ? "text-ink-tertiary" : "text-ink-primary"}>{handoffLabel(item.handoffType)}</p>
      <p className={schedule.primary === "Nog geen datum" ? "text-xs text-ink-tertiary" : "text-xs text-ink-secondary"}>
        {schedule.primary}
      </p>
      {schedule.secondary && <p className="text-xs text-ink-tertiary">{schedule.secondary}</p>}
    </div>
  );
}

/** Completed orders stay short: a finished order needs a status and a
 * completion date, not a progress read-out. */
function WarehouseCell({ item, unavailable }: { item: OrderLogisticsSummary | undefined; unavailable: boolean }) {
  if (!item) return <Unknown unavailable={unavailable} />;

  const status = statusLabel(item.operationalStatus);
  const palletsOutstanding = item.pallets.total > 0 && item.pallets.scanned < item.pallets.total;

  return (
    <div className="space-y-0.5">
      <p className="text-ink-primary">{status}</p>
      {item.lock.active && (
        <p className="inline-flex items-center gap-1 text-xs text-warning-700">
          <Lock className="h-3 w-3" aria-hidden />
          {item.lock.claimedByName ? `Wordt gepickt door ${item.lock.claimedByName}` : "Wordt nu gepickt"}
        </p>
      )}
      {item.pick.completed ? (
        <p className="text-xs text-ink-tertiary">
          {item.pick.completedAt ? `Gepickt ${formatDate(item.pick.completedAt)}` : "Gepickt"}
        </p>
      ) : (
        <p className="text-xs tabular-nums text-ink-secondary">
          {item.pick.pickedLines} / {item.pick.totalLines} regels gepickt
        </p>
      )}
      {item.pallets.total > 0 && (
        <p className={palletsOutstanding ? "text-xs tabular-nums text-ink-secondary" : "text-xs tabular-nums text-ink-tertiary"}>
          {item.pallets.scanned} / {item.pallets.total} pallets gescand
        </p>
      )}
    </div>
  );
}

/** Absence of data and a broken integration are two different things, and
 * neither is allowed to read as "not picked". */
function Unknown({ unavailable }: { unavailable: boolean }) {
  return <span className="text-xs text-ink-tertiary">{unavailable ? "Niet beschikbaar" : "—"}</span>;
}

import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDate, formatMoney } from "@/lib/format";
import type { ShopifyOrderSummary } from "@/integrations/shopify/types";

const FINANCIAL_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  PAID: "success",
  PENDING: "warning",
  PARTIALLY_PAID: "warning",
  AUTHORIZED: "warning",
  REFUNDED: "neutral",
  VOIDED: "danger",
};

export function OrdersTable({ orders }: { orders: ShopifyOrderSummary[] }) {
  if (orders.length === 0) {
    return <EmptyState title="Geen orders" description="Deze klant heeft nog geen Shopify-bestellingen." />;
  }

  return (
    <div className="cc-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-subtle text-left text-xs text-ink-tertiary">
            <th className="px-4 py-2.5 font-medium">Order</th>
            <th className="px-4 py-2.5 font-medium">Datum</th>
            <th className="px-4 py-2.5 font-medium">Betaalstatus</th>
            <th className="px-4 py-2.5 font-medium">Fulfillment</th>
            <th className="px-4 py-2.5 font-medium text-right">Totaal</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {orders.map((order) => (
            <tr key={order.gid} className="hover:bg-canvas">
              <td className="px-4 py-2.5 font-medium text-ink-primary">{order.name}</td>
              <td className="px-4 py-2.5 text-ink-secondary">{formatDate(order.createdAt)}</td>
              <td className="px-4 py-2.5">
                {order.displayFinancialStatus ? (
                  <Badge tone={FINANCIAL_TONE[order.displayFinancialStatus] ?? "neutral"}>
                    {order.displayFinancialStatus}
                  </Badge>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-2.5 text-ink-secondary">{order.displayFulfillmentStatus ?? "—"}</td>
              <td className="px-4 py-2.5 text-right font-medium tabular-nums text-ink-primary">
                {formatMoney(order.currentTotalPriceSet)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { ShoppingBag, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
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
    return (
      <EmptyState
        icon={<ShoppingBag className="h-5 w-5" />}
        title="Geen orders"
        description="Deze klant heeft nog geen Shopify-bestellingen."
      />
    );
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Order</TableHeaderCell>
        <TableHeaderCell>Datum</TableHeaderCell>
        <TableHeaderCell>Betaalstatus</TableHeaderCell>
        <TableHeaderCell>Fulfillment</TableHeaderCell>
        <TableHeaderCell className="text-right">Totaal</TableHeaderCell>
        <TableHeaderCell className="w-8">
          <span className="sr-only">Acties</span>
        </TableHeaderCell>
      </TableHead>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.gid}>
            <TableCell className="font-medium text-ink-primary">{order.name}</TableCell>
            <TableCell className="text-ink-secondary">{formatDate(order.createdAt)}</TableCell>
            <TableCell>
              {order.displayFinancialStatus ? (
                <Badge tone={FINANCIAL_TONE[order.displayFinancialStatus] ?? "neutral"}>{order.displayFinancialStatus}</Badge>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-ink-secondary">{order.displayFulfillmentStatus ?? "—"}</TableCell>
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
        ))}
      </TableBody>
    </Table>
  );
}

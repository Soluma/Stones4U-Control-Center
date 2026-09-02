import { FileClock, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { formatDate, formatMoney } from "@/lib/format";
import type { ShopifyDraftOrderSummary } from "@/integrations/shopify/types";

const STATUS_TONE: Record<string, "success" | "warning" | "neutral"> = {
  OPEN: "neutral",
  INVOICE_SENT: "warning",
  COMPLETED: "success",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  INVOICE_SENT: "Factuur verstuurd",
  COMPLETED: "Voltooid",
};

export function DraftOrdersTable({ draftOrders, unavailable }: { draftOrders: ShopifyDraftOrderSummary[] | null; unavailable?: boolean }) {
  if (unavailable) {
    return (
      <EmptyState
        tone="error"
        icon={<FileClock className="h-5 w-5" />}
        title="Conceptbestellingen tijdelijk niet beschikbaar"
        description="Kon geen verbinding maken met Shopify voor conceptbestellingen. De rest van deze pagina blijft bruikbaar."
      />
    );
  }

  if (!draftOrders || draftOrders.length === 0) {
    return (
      <EmptyState
        icon={<FileClock className="h-5 w-5" />}
        title="Geen conceptbestellingen"
        description="Deze klant heeft geen openstaande Shopify-conceptorders."
      />
    );
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Concept</TableHeaderCell>
        <TableHeaderCell>Bijgewerkt</TableHeaderCell>
        <TableHeaderCell>Status</TableHeaderCell>
        <TableHeaderCell className="text-right">Totaal</TableHeaderCell>
        <TableHeaderCell className="w-8">
          <span className="sr-only">Acties</span>
        </TableHeaderCell>
      </TableHead>
      <TableBody>
        {draftOrders.map((draftOrder) => (
          <TableRow key={draftOrder.gid}>
            <TableCell className="font-medium text-ink-primary">
              {draftOrder.name}
              {draftOrder.completedOrder && (
                <a
                  href={draftOrder.completedOrder.adminUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-2 text-xs font-normal text-accent-600 hover:underline"
                >
                  → {draftOrder.completedOrder.name}
                </a>
              )}
            </TableCell>
            <TableCell className="text-ink-secondary">{formatDate(draftOrder.updatedAt)}</TableCell>
            <TableCell>
              <Badge tone={STATUS_TONE[draftOrder.status] ?? "neutral"}>{STATUS_LABEL[draftOrder.status] ?? draftOrder.status}</Badge>
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums text-ink-primary">
              {formatMoney(draftOrder.totalPriceSet)}
            </TableCell>
            <TableCell>
              <a
                href={draftOrder.adminUrl}
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

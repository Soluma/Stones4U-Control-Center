import { CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { formatDate } from "@/lib/format";
import type { DeliveryDateHandoff } from "@/generated/prisma";

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = {
  PENDING: "neutral",
  MIRRORED: "success",
  ERROR: "danger",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "In afwachting",
  MIRRORED: "Doorgegeven aan Shopify",
  ERROR: "Doorgeven mislukt",
};

// Read-only. Never an edit control — this is a customer wish, not a
// definitive planning date, and never touches
// hoefnagels_delivery_date/transport planning (this repo has no such
// module yet — see docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md §domain
// isolation).
export function DeliveryDateHandoffsPanel({ handoffs }: { handoffs: DeliveryDateHandoff[] }) {
  if (handoffs.length === 0) {
    return (
      <EmptyState
        icon={<CalendarClock className="h-5 w-5" />}
        title="Geen gewenste leverdatum"
        description="Deze klant heeft nog geen gewenste leverdatum opgegeven."
      />
    );
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Gewenste leverdatum klant</TableHeaderCell>
        <TableHeaderCell>Bron</TableHeaderCell>
        <TableHeaderCell>Status</TableHeaderCell>
      </TableHead>
      <TableBody>
        {handoffs.map((handoff) => (
          <TableRow key={handoff.id}>
            <TableCell className="font-medium text-ink-primary">
              {handoff.requestedDeliveryDate ? formatDate(handoff.requestedDeliveryDate) : "Nog niet gekozen"}
              <span className="ml-2 text-xs font-normal text-ink-tertiary">(wens, geen toezegging)</span>
            </TableCell>
            <TableCell className="text-ink-secondary">{handoff.shopifyDraftOrderGid ?? handoff.externalId}</TableCell>
            <TableCell>
              <Badge tone={STATUS_TONE[handoff.status] ?? "neutral"}>{STATUS_LABEL[handoff.status] ?? handoff.status}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

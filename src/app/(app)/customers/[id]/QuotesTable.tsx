import { FileText, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { formatDate } from "@/lib/format";
import type { QuoteSummary } from "@/integrations/quotes/adapter";

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = {
  draft: "neutral",
  new: "neutral",
  saved: "neutral",
  in_progress: "warning",
  sent: "warning",
  synced_draft_order: "warning",
  accepted: "success",
  invoiced: "success",
  converted_to_order: "success",
  rejected: "danger",
  archived: "neutral",
};

const SOURCE_LABEL: Record<QuoteSummary["sourceSystem"], string> = {
  OFFERTEAPP: "OfferteApp",
  S4U_QUOTE_APP: "Webshop-offerte",
};

export function QuotesTable({ quotes, unavailable }: { quotes: QuoteSummary[] | null; unavailable?: boolean }) {
  if (unavailable) {
    return (
      <EmptyState
        tone="error"
        icon={<FileText className="h-5 w-5" />}
        title="Offertes tijdelijk niet beschikbaar"
        description="Kon geen verbinding maken met de offerte-systemen. De rest van deze pagina blijft bruikbaar."
      />
    );
  }

  if (!quotes || quotes.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="h-5 w-5" />}
        title="Geen offertes"
        description="Er zijn geen offertes bekend voor deze klant."
      />
    );
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Offerte</TableHeaderCell>
        <TableHeaderCell>Bron</TableHeaderCell>
        <TableHeaderCell>Datum</TableHeaderCell>
        <TableHeaderCell>Status</TableHeaderCell>
        <TableHeaderCell className="text-right">Bedrag</TableHeaderCell>
        <TableHeaderCell className="w-8">
          <span className="sr-only">Acties</span>
        </TableHeaderCell>
      </TableHead>
      <TableBody>
        {quotes.map((quote) => (
          <TableRow key={`${quote.sourceSystem}-${quote.externalId}`}>
            <TableCell className="font-medium text-ink-primary">{quote.displayNumber}</TableCell>
            <TableCell className="text-ink-secondary">{SOURCE_LABEL[quote.sourceSystem]}</TableCell>
            <TableCell className="text-ink-secondary">{formatDate(quote.createdAt)}</TableCell>
            <TableCell>
              <Badge tone={STATUS_TONE[quote.status] ?? "neutral"}>{quote.status}</Badge>
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums text-ink-primary">
              {quote.currency} {quote.total}
            </TableCell>
            <TableCell>
              <a
                href={quote.adminUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center justify-center text-ink-tertiary hover:text-ink-secondary"
                title={`Openen in ${SOURCE_LABEL[quote.sourceSystem]}`}
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

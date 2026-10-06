import Link from "next/link";
import { ExternalLink, FileText, Search } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { StatStrip } from "@/components/sales/StatStrip";
import { formatDate, formatMoney } from "@/lib/format";
import { QUOTE_RESULTS_PER_SOURCE, quoteSearchParams } from "@/integrations/quotes/adapter";
import { loadQuotesOverview, type QuoteOverviewRow } from "@/modules/sales/sales-overview";
import {
  QUOTE_ACTION_LABELS,
  QUOTE_SOURCE_LABELS,
  draftOrderDisplay,
  filterQuotes,
  isNameOnlyQuoteTerm,
  parseQuoteSourceFilter,
  quoteStats,
  quoteStatusLabel,
  quoteStatusTone,
  statusOptions,
} from "@/modules/sales/quote-presentation";

type PageProps = { searchParams: Promise<{ q?: string; bron?: string; status?: string }> };

// Sales → Offertes. Read-only. Both quote sources only answer a lookup
// (offertenummer, e-mail, telefoon) — there is no global list to show yet, so
// the page starts with a search instead of pretending to be complete.
export default async function QuotesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;
  const { q = "", bron, status = "" } = await searchParams;
  const term = q.trim();
  const source = parseQuoteSourceFilter(bron);
  // A name can never match (no source searches on names), so it is not sent
  // to the sources at all and the page says why instead of "niets gevonden".
  const nameOnly = isNameOnlyQuoteTerm(term);
  const searched = !nameOnly && quoteSearchParams(term) !== null;
  const overview = searched ? await loadQuotesOverview(term) : null;

  const found = overview?.rows ?? [];
  const visible = filterQuotes(found, { source, status });
  const stats = quoteStats(found);
  const sourceStates = overview?.sources;
  const bothDown =
    !!sourceStates && sourceStates.OFFERTEAPP !== "ok" && sourceStates.S4U_QUOTE_APP !== "ok";
  const downSources = sourceStates
    ? (Object.keys(sourceStates) as (keyof typeof sourceStates)[]).filter((s) => sourceStates[s] === "unavailable")
    : [];
  const limited = overview ? (Object.keys(overview.limitReached) as (keyof typeof overview.limitReached)[]).filter((s) => overview.limitReached[s]) : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Offertes</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Alle offertes uit de webshop en OfferteApp op één plek.</p>
      </div>

      <form method="get" className="cc-card flex flex-col gap-3 p-3 sm:flex-row sm:items-end" role="search">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Zoek offerte</span>
          <input
            name="q"
            defaultValue={term}
            placeholder="Offertenummer, e-mailadres of telefoonnummer…"
            className="cc-input w-full"
            autoComplete="off"
            data-testid="quotes-search"
          />
        </label>
        <label className="sm:w-44">
          <span className="cc-label">Bron</span>
          <select name="bron" defaultValue={source} className="cc-input w-full">
            <option value="all">Alle</option>
            <option value="offerteapp">OfferteApp</option>
            <option value="webshop">Webshop</option>
          </select>
        </label>
        <label className="sm:w-48">
          <span className="cc-label">Status</span>
          <select name="status" defaultValue={status} className="cc-input w-full" disabled={found.length === 0}>
            <option value="">Alle statussen</option>
            {statusOptions(found).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="cc-btn-primary shrink-0">
          <Search className="h-3.5 w-3.5" aria-hidden />
          Zoeken
        </button>
      </form>

      {nameOnly ? (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title="Zoeken op naam kan hier nog niet"
          description={`"${term}" lijkt een naam. Offertes zijn alleen te vinden op offertenummer, e-mailadres of telefoonnummer. Zoek de klant via Klanten — in Customer 360 staan de offertes onder Commercieel.`}
          action={
            <Link href="/customers" className="cc-btn-secondary" data-testid="quotes-to-customers">
              Naar Klanten
            </Link>
          }
        />
      ) : !searched ? (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title="Zoek een offerte"
          description={
            term
              ? "Typ minstens 2 tekens. Zoek op offertenummer, e-mailadres of telefoonnummer."
              : "Zoek op offertenummer, e-mailadres of telefoonnummer."
          }
        />
      ) : bothDown ? (
        <EmptyState
          tone="error"
          icon={<FileText className="h-5 w-5" />}
          title="Offertes tijdelijk niet beschikbaar"
          description="OfferteApp en de webshop-offertes reageren nu niet. Probeer het zo opnieuw."
        />
      ) : (
        <>
          {downSources.length > 0 && (
            <p role="status" className="rounded-md border border-warning-500/20 bg-warning-50 px-3 py-2 text-sm text-warning-700">
              {downSources.map((s) => QUOTE_SOURCE_LABELS[s]).join(" en ")} reageert nu niet — je ziet alleen resultaten uit de andere bron.
            </p>
          )}

          <StatStrip
            scope={`Aantallen over de ${found.length} gevonden offerte${found.length === 1 ? "" : "s"} voor "${term}" — niet over alle offertes.`}
            items={[
              { label: "Nieuw", value: stats.new, tone: "accent" },
              { label: "In behandeling", value: stats.inProgress, tone: "warning" },
              { label: "Verzonden", value: stats.sent },
              { label: "Totaal zichtbaar", value: visible.length },
            ]}
          />

          {limited.length > 0 && (
            <p className="text-xs text-ink-tertiary" data-testid="quotes-limit">
              Mogelijk niet alle resultaten: {limited.map((s) => QUOTE_SOURCE_LABELS[s]).join(" en ")} geeft maximaal{" "}
              {QUOTE_RESULTS_PER_SOURCE} offertes per zoekopdracht. Maak je zoekterm specifieker.
            </p>
          )}

          {visible.length === 0 ? (
            found.length > 0 ? (
              <EmptyState
                icon={<FileText className="h-5 w-5" />}
                title={`${found.length} offerte${found.length === 1 ? "" : "s"} gevonden, maar 0 voldoen aan de huidige filters`}
                description="De gekozen bron of status sluit alle resultaten uit."
                action={
                  <Link href={`/quotes?q=${encodeURIComponent(term)}`} className="cc-btn-secondary" data-testid="quotes-clear-filters">
                    Filters wissen
                  </Link>
                }
              />
            ) : (
              <EmptyState
                icon={<FileText className="h-5 w-5" />}
                title="Geen offertes gevonden"
                description={`Geen offerte met dit nummer, e-mailadres of telefoonnummer in OfferteApp of de webshop.`}
              />
            )
          ) : (
            <QuotesOverviewTable rows={visible} draftOrderNames={overview!.draftOrderNames} />
          )}
        </>
      )}
    </div>
  );
}

function CustomerCell({ row }: { row: QuoteOverviewRow }) {
  if (row.customer) {
    return (
      <Link href={`/customers/${row.customer.id}?tab=orders`} className="cc-focus-ring font-medium text-ink-primary hover:text-accent-700">
        {row.customer.name}
      </Link>
    );
  }
  const fallback = row.email ?? row.phone;
  return <span className="text-ink-secondary">{fallback ?? "—"}</span>;
}

function Amount({ row }: { row: QuoteOverviewRow }) {
  if (row.total === null || row.total === undefined || row.total === "") return <>—</>;
  return <>{formatMoney({ amount: row.total, currencyCode: row.currency || "EUR" })}</>;
}

function ExternalAction({ row }: { row: QuoteOverviewRow }) {
  return (
    <a
      href={row.adminUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-xs font-medium text-accent-600 hover:underline"
    >
      {QUOTE_ACTION_LABELS[row.sourceSystem]}
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

function QuotesOverviewTable({ rows, draftOrderNames }: { rows: QuoteOverviewRow[]; draftOrderNames: Map<string, string> }) {
  return (
    <div className="space-y-2" data-testid="quotes-table">
      <ul className="cc-card divide-y divide-border-subtle md:hidden">
        {rows.map((row) => {
          const draft = draftOrderDisplay(row.shopifyDraftOrderGid, draftOrderNames);
          return (
            <li key={`${row.sourceSystem}-${row.externalId}`} className="space-y-1.5 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium text-ink-primary">{row.displayNumber}</span>
                <Badge tone={quoteStatusTone(row.status)}>{quoteStatusLabel(row.status)}</Badge>
              </div>
              <div className="min-w-0 truncate text-sm">
                <CustomerCell row={row} />
              </div>
              <p className="text-xs text-ink-tertiary">
                {QUOTE_SOURCE_LABELS[row.sourceSystem]} · {formatDate(row.createdAt)} ·{" "}
                <span className="tabular-nums">
                  <Amount row={row} />
                </span>
                {draft ? ` · Conceptorder ${draft}` : ""}
              </p>
              <ExternalAction row={row} />
            </li>
          );
        })}
      </ul>

      <div className="hidden md:block">
        <Table>
          <TableHead>
            <TableHeaderCell>Offertenummer</TableHeaderCell>
            <TableHeaderCell>Klant</TableHeaderCell>
            <TableHeaderCell>Bron</TableHeaderCell>
            <TableHeaderCell>Datum</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell className="text-right">Bedrag</TableHeaderCell>
            <TableHeaderCell>Conceptorder</TableHeaderCell>
            <TableHeaderCell>Actie</TableHeaderCell>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.sourceSystem}-${row.externalId}`}>
                <TableCell className="whitespace-nowrap font-medium text-ink-primary">{row.displayNumber}</TableCell>
                <TableCell className="max-w-[12rem] truncate">
                  <CustomerCell row={row} />
                </TableCell>
                <TableCell className="text-ink-secondary">{QUOTE_SOURCE_LABELS[row.sourceSystem]}</TableCell>
                <TableCell className="whitespace-nowrap text-ink-secondary">{formatDate(row.createdAt)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge tone={quoteStatusTone(row.status)}>{quoteStatusLabel(row.status)}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right font-medium tabular-nums text-ink-primary">
                  <Amount row={row} />
                </TableCell>
                <TableCell className="text-ink-secondary">{draftOrderDisplay(row.shopifyDraftOrderGid, draftOrderNames) ?? "—"}</TableCell>
                <TableCell>
                  <ExternalAction row={row} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

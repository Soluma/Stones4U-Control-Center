import Link from "next/link";
import { redirect } from "next/navigation";
import { ExternalLink, FileText, Search, UserRound } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { StatStrip } from "@/components/sales/StatStrip";
import { formatDate, formatMoney } from "@/lib/format";
import { QUOTE_RESULTS_PER_SOURCE } from "@/integrations/quotes/adapter";
import { searchQuotesOverview, type QuoteCustomerChoice, type QuoteOverviewRow, type QuotesOverview } from "@/modules/sales/sales-overview";
import {
  QUOTE_ACTION_LABELS,
  QUOTE_SOURCE_LABELS,
  draftOrderDisplay,
  filterQuotes,
  parseQuoteSourceFilter,
  quoteStats,
  quoteStatusLabel,
  quoteStatusTone,
  statusOptions,
} from "@/modules/sales/quote-presentation";

type PageProps = { searchParams: Promise<{ q?: string; bron?: string; status?: string; customer?: string; for?: string }> };

// Sales → Offertes. Read-only. Offertenummer, e-mail and phone go straight to
// the quote sources; a name is first resolved to a Shopify customer, whose
// hard identifiers are then used (sales-overview.ts searchQuotesOverview).
// There is no global list to show yet, so the page starts with a search.
export default async function QuotesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;
  const sp = await searchParams;
  const term = (sp.q ?? "").trim();
  const status = sp.status ?? "";
  const source = parseQuoteSourceFilter(sp.bron);
  // A picked customer only counts for the term it was picked for; the server
  // re-checks it against a fresh Shopify search either way. A pick left over
  // from an earlier term is dropped from the URL instead of lingering there.
  if ((sp.customer !== undefined || sp.for !== undefined) && sp.for !== term) {
    const clean = new URLSearchParams();
    if (term) clean.set("q", term);
    if (sp.bron) clean.set("bron", sp.bron);
    if (sp.status) clean.set("status", sp.status);
    redirect(clean.size > 0 ? `/quotes?${clean.toString()}` : "/quotes");
  }
  const selectedCustomer = sp.for === term ? sp.customer : undefined;
  const outcome = term ? await searchQuotesOverview(term, selectedCustomer) : ({ kind: "start" } as const);

  const found = outcome.kind === "quotes" ? outcome.overview.rows : [];
  const pinnedCustomer = outcome.kind === "quotes" && outcome.customer && outcome.customerCount > 1 ? outcome.customer : null;
  const clearFiltersQuery = new URLSearchParams({ q: term });
  if (pinnedCustomer) {
    clearFiltersQuery.set("customer", pinnedCustomer.legacyId);
    clearFiltersQuery.set("for", term);
  }

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
            placeholder="Offertenummer, klantnaam, bedrijf, e-mail of telefoon…"
            className="cc-input w-full"
            autoComplete="off"
            data-testid="quotes-search"
          />
        </label>
        {pinnedCustomer && (
          <>
            <input type="hidden" name="customer" value={pinnedCustomer.legacyId} />
            <input type="hidden" name="for" value={term} />
          </>
        )}
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

      {outcome.kind === "start" ? (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title="Zoek een offerte"
          description={
            term
              ? "Typ minstens 2 tekens. Zoek op offertenummer, klantnaam, bedrijf, e-mailadres of telefoonnummer."
              : "Zoek op offertenummer, klantnaam, bedrijf, e-mailadres of telefoonnummer."
          }
        />
      ) : outcome.kind === "customer_search_failed" ? (
        <EmptyState
          tone="error"
          icon={<UserRound className="h-5 w-5" />}
          title="Klant zoeken lukt nu niet"
          description="Shopify reageert nu niet. Zoek rechtstreeks op offertenummer, e-mailadres of telefoonnummer, of probeer het zo opnieuw."
        />
      ) : outcome.kind === "no_customer" ? (
        <EmptyState
          icon={<UserRound className="h-5 w-5" />}
          title={`Geen klant gevonden voor "${term}"`}
          description="Zoek rechtstreeks op offertenummer, e-mailadres of telefoonnummer."
        />
      ) : outcome.kind === "choose_customer" ? (
        <CustomerChooser
          term={term}
          customers={outcome.customers}
          invalidSelection={outcome.invalidSelection}
          hasMoreCustomers={outcome.hasMoreCustomers}
        />
      ) : (
        <QuotesResults
          term={term}
          overview={outcome.overview}
          customer={outcome.customer}
          customerCount={outcome.customerCount}
          source={source}
          status={status}
          clearFiltersHref={`/quotes?${clearFiltersQuery.toString()}`}
        />
      )}
    </div>
  );
}

function CustomerChooser({
  term,
  customers,
  invalidSelection,
  hasMoreCustomers,
}: {
  term: string;
  customers: QuoteCustomerChoice[];
  invalidSelection: boolean;
  hasMoreCustomers: boolean;
}) {
  return (
    <section className="space-y-3" data-testid="quotes-customer-choice" aria-labelledby="quotes-choose-title">
      {invalidSelection && (
        <p role="status" className="rounded-md border border-warning-500/20 bg-warning-50 px-3 py-2 text-sm text-warning-700">
          De gekozen klant hoort niet bij deze zoekterm. Kies hieronder opnieuw.
        </p>
      )}
      <h2 id="quotes-choose-title" className="text-sm font-medium text-ink-secondary">
        {customers.length === 1 ? `Klant gevonden voor "${term}"` : `Meerdere klanten gevonden voor "${term}"`} — kies een klant om de offertes te zien
      </h2>
      {hasMoreCustomers && (
        <p role="status" className="rounded-md border border-warning-500/20 bg-warning-50 px-3 py-2 text-sm text-warning-700" data-testid="quotes-more-customers">
          Meer klanten gevonden. Verfijn je zoekterm om de juiste klant te vinden.
        </p>
      )}
      <ul className="cc-card divide-y divide-border-subtle">
        {customers.map((c) => (
          <li key={c.legacyId}>
            <Link
              href={`/quotes?${new URLSearchParams({ q: term, customer: c.legacyId, for: term }).toString()}`}
              className="cc-table-row cc-focus-ring flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink-primary">{c.company || c.displayName}</span>
                {c.company && c.displayName !== c.company && <span className="block truncate text-xs text-ink-tertiary">{c.displayName}</span>}
              </span>
              <span className="min-w-0 truncate text-xs text-ink-tertiary sm:text-right">{[c.email, c.place].filter(Boolean).join(" · ") || "—"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuotesResults({
  term,
  overview,
  customer,
  customerCount,
  source,
  status,
  clearFiltersHref,
}: {
  term: string;
  overview: QuotesOverview;
  customer: QuoteCustomerChoice | null;
  customerCount: number;
  source: ReturnType<typeof parseQuoteSourceFilter>;
  status: string;
  clearFiltersHref: string;
}) {
  const found = overview.rows;
  const visible = filterQuotes(found, { source, status });
  const stats = quoteStats(found);
  const sourceStates = overview.sources;
  const bothDown = sourceStates.OFFERTEAPP !== "ok" && sourceStates.S4U_QUOTE_APP !== "ok";
  const downSources = (Object.keys(sourceStates) as (keyof typeof sourceStates)[]).filter((s) => sourceStates[s] === "unavailable");
  const limited = (Object.keys(overview.limitReached) as (keyof typeof overview.limitReached)[]).filter((s) => overview.limitReached[s]);
  const customerName = customer ? customer.company || customer.displayName : null;

  return (
    <>
      {customer && (
        <div className="flex flex-wrap items-baseline justify-between gap-2" data-testid="quotes-customer-header">
          <h2 className="text-base font-semibold text-ink-primary">Offertes voor {customerName}</h2>
          {customerCount > 1 && (
            <Link href={`/quotes?${new URLSearchParams({ q: term }).toString()}`} className="text-xs font-medium text-accent-600 hover:underline">
              Andere klant kiezen
            </Link>
          )}
        </div>
      )}

      {bothDown ? (
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
            scope={`Aantallen over de ${found.length} gevonden offerte${found.length === 1 ? "" : "s"} ${customerName ? `voor ${customerName}` : `voor "${term}"`} — niet over alle offertes.`}
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
                  <Link href={clearFiltersHref} className="cc-btn-secondary" data-testid="quotes-clear-filters">
                    Filters wissen
                  </Link>
                }
              />
            ) : (
              <EmptyState
                icon={<FileText className="h-5 w-5" />}
                title="Geen offertes gevonden"
                description={
                  customerName
                    ? `Geen offertes voor ${customerName} in OfferteApp of de webshop (gezocht op Shopify-klant, e-mailadres en telefoonnummer).`
                    : "Geen offerte met dit nummer, e-mailadres of telefoonnummer in OfferteApp of de webshop."
                }
              />
            )
          ) : (
            <QuotesOverviewTable rows={visible} draftOrderNames={overview.draftOrderNames} />
          )}
        </>
      )}
    </>
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

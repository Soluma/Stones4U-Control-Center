import Link from "next/link";
import { ChevronLeft, ChevronRight, ExternalLink, Search, ShoppingBag } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { StatStrip } from "@/components/sales/StatStrip";
import { formatDate, formatMoney } from "@/lib/format";
import { ORDERS_PAGE_SIZE } from "@/integrations/shopify/orders";
import { HandoffCell, WarehouseCell } from "../customers/[id]/OrdersTable";
import { loadOrdersOverview, type OrderOverviewRow, type OrdersLogistics } from "@/modules/sales/sales-overview";
import { handoffLabel, scheduleDisplay } from "@/modules/logistics/presentation";
import {
  FINANCIAL_FILTERS,
  FULFILLMENT_FILTERS,
  HANDOFF_FILTERS,
  filterByHandoff,
  financialLabel,
  financialTone,
  fulfillmentLabel,
  orderStats,
  pickFilter,
} from "@/modules/sales/order-presentation";

type PageProps = {
  searchParams: Promise<{ q?: string; betaling?: string; fulfillment?: string; afhandeling?: string; after?: string; before?: string }>;
};

// Sales → Orders. Shopify is the commercial source of truth: one page of 50
// orders straight from Shopify (filtered by Shopify, paged by cursor), with
// the warehouse side from OfferteApp in one batch for the visible orders.
export default async function OrdersPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;
  const params = await searchParams;
  const term = (params.q ?? "").trim();
  const financial = pickFilter(FINANCIAL_FILTERS, params.betaling);
  const fulfillment = pickFilter(FULFILLMENT_FILTERS, params.fulfillment);
  const handoff = pickFilter(HANDOFF_FILTERS, params.afhandeling);

  const overview = await loadOrdersOverview({ term, financial, fulfillment, after: params.after, before: params.before });

  const filterQuery = (extra: Record<string, string>) => {
    const sp = new URLSearchParams();
    if (term) sp.set("q", term);
    if (financial) sp.set("betaling", financial);
    if (fulfillment) sp.set("fulfillment", fulfillment);
    if (handoff) sp.set("afhandeling", handoff);
    for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    const s = sp.toString();
    return s ? `/orders?${s}` : "/orders";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Orders</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Verkoop, betaling, magazijn en levering in één overzicht.</p>
      </div>

      <form method="get" className="cc-card grid gap-3 p-3 sm:grid-cols-2 lg:flex lg:items-end" role="search">
        <label className="min-w-0 sm:col-span-2 lg:flex-1">
          <span className="sr-only">Zoek ordernummer</span>
          <input name="q" defaultValue={term} placeholder="Zoek ordernummer…" className="cc-input w-full" autoComplete="off" data-testid="orders-search" />
        </label>
        <FilterSelect name="betaling" label="Betaalstatus" value={financial} options={FINANCIAL_FILTERS} />
        <FilterSelect name="fulfillment" label="Fulfillment" value={fulfillment} options={FULFILLMENT_FILTERS} />
        <FilterSelect name="afhandeling" label="Afhandeling" value={handoff} options={HANDOFF_FILTERS} />
        <button type="submit" className="cc-btn-primary shrink-0">
          <Search className="h-3.5 w-3.5" aria-hidden />
          Toepassen
        </button>
      </form>

      {!overview.ok ? (
        <EmptyState
          tone="error"
          icon={<ShoppingBag className="h-5 w-5" />}
          title="Shopify is niet bereikbaar"
          description="De orders konden niet worden opgehaald. Probeer het zo opnieuw."
        />
      ) : (
        <OrdersContent
          rows={overview.rows}
          logistics={overview.logistics}
          handoff={handoff}
          pageInfo={overview.page.pageInfo}
          filterQuery={filterQuery}
          filtered={!!(term || financial || fulfillment)}
        />
      )}
    </div>
  );
}

function FilterSelect({ name, label, value, options }: { name: string; label: string; value: string; options: { value: string; label: string }[] }) {
  return (
    <label className="min-w-0 lg:w-44">
      <span className="cc-label">{label}</span>
      <select name={name} defaultValue={value} className="cc-input w-full">
        <option value="">Alle</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function OrdersContent({
  rows,
  logistics,
  handoff,
  pageInfo,
  filterQuery,
  filtered,
}: {
  rows: OrderOverviewRow[];
  logistics: OrdersLogistics;
  handoff: string;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  filterQuery: (extra: Record<string, string>) => string;
  filtered: boolean;
}) {
  const logisticsMap = logistics.notConfigured ? null : logistics.byOrderId;
  const visible = filterByHandoff(rows, handoff, logisticsMap);
  const stats = orderStats(rows, logisticsMap);

  return (
    <>
      <StatStrip
        scope={`Aantallen over de ${rows.length} orders op deze pagina (maximaal ${ORDERS_PAGE_SIZE}).`}
        items={[
          { label: "Nieuw (7 dagen)", value: stats.recent, tone: "accent" },
          { label: "Open betaling", value: stats.openPayment, tone: "warning" },
          { label: "Nog te verwerken", value: stats.toProcess },
          { label: "Actie nodig", value: stats.actionNeeded, tone: "danger" },
        ]}
      />

      {(logistics.unavailable || logistics.notConfigured) && (
        <p role="status" className="rounded-md border border-warning-500/20 bg-warning-50 px-3 py-2 text-sm text-warning-700" data-testid="orders-logistics-unavailable">
          {logistics.notConfigured
            ? "OfferteApp is niet gekoppeld — afhandeling, magazijn en leverdatum zijn niet beschikbaar."
            : "Magazijngegevens uit OfferteApp zijn tijdelijk niet (volledig) beschikbaar. Shopify-gegevens zijn wel actueel."}
        </p>
      )}
      {handoff && (
        <p className="text-xs text-ink-tertiary">
          Afhandeling &ldquo;{HANDOFF_FILTERS.find((h) => h.value === handoff)?.label}&rdquo; filtert alleen de orders op deze pagina.
        </p>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={<ShoppingBag className="h-5 w-5" />}
          title="Geen orders gevonden"
          description={filtered || handoff ? "Geen orders met deze zoekterm of filters." : "Shopify heeft nog geen orders."}
        />
      ) : (
        <OrdersOverviewTable rows={visible} logistics={logistics} />
      )}

      {(pageInfo.hasPreviousPage || pageInfo.hasNextPage) && (
        <nav className="flex items-center justify-between gap-3" aria-label="Paginering">
          {pageInfo.hasPreviousPage && pageInfo.startCursor ? (
            <Link href={filterQuery({ before: pageInfo.startCursor })} className="cc-btn-secondary" data-testid="orders-prev">
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              Nieuwere orders
            </Link>
          ) : (
            <span />
          )}
          {pageInfo.hasNextPage && pageInfo.endCursor ? (
            <Link href={filterQuery({ after: pageInfo.endCursor })} className="cc-btn-secondary" data-testid="orders-next">
              Oudere orders
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}

function OrderName({ row }: { row: OrderOverviewRow }) {
  // The existing order page checks the order belongs to that customer, so
  // it is only linked when the Shopify customer resolved to a profile exactly.
  if (row.customerProfile) {
    return (
      <Link href={`/customers/${row.customerProfile.id}/orders/${row.legacyResourceId}`} className="cc-focus-ring font-medium text-ink-primary hover:text-accent-700">
        {row.name}
      </Link>
    );
  }
  return <span className="font-medium text-ink-primary">{row.name}</span>;
}

function CustomerName({ row }: { row: OrderOverviewRow }) {
  if (row.customerProfile) {
    return (
      <Link href={`/customers/${row.customerProfile.id}`} className="cc-focus-ring text-ink-primary hover:text-accent-700">
        {row.customerProfile.name}
      </Link>
    );
  }
  if (row.customer) return <span className="text-ink-secondary">{row.customer.displayName}</span>;
  return <span className="text-ink-tertiary">Geen klant</span>;
}

function FinancialBadge({ row }: { row: OrderOverviewRow }) {
  if (row.cancelledAt) return <Badge tone="danger">Geannuleerd</Badge>;
  if (!row.displayFinancialStatus) return <>—</>;
  return <Badge tone={financialTone(row.displayFinancialStatus)}>{financialLabel(row.displayFinancialStatus)}</Badge>;
}

function AdminLink({ row }: { row: OrderOverviewRow }) {
  return (
    <a
      href={row.adminUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-accent-600 hover:underline"
      title="Openen in Shopify Admin"
    >
      Shopify
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

function OrdersOverviewTable({ rows, logistics }: { rows: OrderOverviewRow[]; logistics: OrdersLogistics }) {
  const unavailable = logistics.unavailable || logistics.notConfigured;
  return (
    <div className="space-y-2" data-testid="orders-table">
      {/* Onder md gestapeld, zelfde patroon als OrdersTable in Customer 360. */}
      <ul className="cc-card divide-y divide-border-subtle md:hidden">
        {rows.map((row) => {
          const item = logistics.byOrderId.get(row.legacyResourceId);
          return (
            <li key={row.gid} className="space-y-1.5 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <OrderName row={row} />
                <FinancialBadge row={row} />
              </div>
              <div className="min-w-0 truncate text-sm">
                <CustomerName row={row} />
              </div>
              <HandoffCell item={item} unavailable={unavailable} />
              <WarehouseCell item={item} unavailable={unavailable} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-tertiary">
                  {formatDate(row.createdAt)} · <span className="tabular-nums">{formatMoney(row.currentTotalPriceSet)}</span> ·{" "}
                  {fulfillmentLabel(row.displayFulfillmentStatus)}
                </p>
                <AdminLink row={row} />
              </div>
            </li>
          );
        })}
      </ul>

      <div className="hidden md:block">
        <Table>
          <TableHead>
            <TableHeaderCell>Order</TableHeaderCell>
            <TableHeaderCell>Klant</TableHeaderCell>
            <TableHeaderCell>Datum</TableHeaderCell>
            <TableHeaderCell className="text-right">Bedrag</TableHeaderCell>
            <TableHeaderCell>Betaling</TableHeaderCell>
            <TableHeaderCell>Afhandeling</TableHeaderCell>
            <TableHeaderCell>Magazijn</TableHeaderCell>
            <TableHeaderCell>Leverdatum</TableHeaderCell>
            <TableHeaderCell>Actie</TableHeaderCell>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const item = logistics.byOrderId.get(row.legacyResourceId);
              const schedule = item ? scheduleDisplay(item.scheduleState, item.requestedDate) : null;
              return (
                <TableRow key={row.gid}>
                  <TableCell className="whitespace-nowrap align-top">
                    <OrderName row={row} />
                  </TableCell>
                  <TableCell className="max-w-[9rem] truncate align-top">
                    <CustomerName row={row} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-ink-secondary">{formatDate(row.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right align-top font-medium tabular-nums text-ink-primary">
                    {formatMoney(row.currentTotalPriceSet)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top">
                    <div className="space-y-0.5">
                      <FinancialBadge row={row} />
                      <p className="text-xs text-ink-tertiary">{fulfillmentLabel(row.displayFulfillmentStatus)}</p>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    {item ? (
                      <span className={item.handoffType === "UNKNOWN" ? "text-ink-tertiary" : "text-ink-primary"}>{handoffLabel(item.handoffType)}</span>
                    ) : (
                      <NoData unavailable={unavailable} />
                    )}
                  </TableCell>
                  <TableCell className="min-w-[10.5rem] align-top">
                    <WarehouseCell item={item} unavailable={unavailable} />
                  </TableCell>
                  <TableCell className="min-w-[8rem] align-top">
                    {schedule ? (
                      <div className="space-y-0.5">
                        <p className={schedule.primary === "Nog geen datum" ? "text-xs text-ink-tertiary" : "text-ink-secondary"}>{schedule.primary}</p>
                        {schedule.secondary && <p className="text-xs text-ink-tertiary">{schedule.secondary}</p>}
                      </div>
                    ) : (
                      <NoData unavailable={unavailable} />
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <AdminLink row={row} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** "Niet beschikbaar" when OfferteApp did not answer; "—" when it answered
 * and simply has nothing for this order. Never the same thing. */
function NoData({ unavailable }: { unavailable: boolean }) {
  return <span className="text-xs text-ink-tertiary">{unavailable ? "Niet beschikbaar" : "—"}</span>;
}

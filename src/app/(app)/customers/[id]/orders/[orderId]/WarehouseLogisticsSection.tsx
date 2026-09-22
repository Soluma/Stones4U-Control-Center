import { TriangleAlert, Lock, Camera, ScanLine, PackageSearch } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatDate, formatDateTime } from "@/lib/format";
import type { LogisticsDetailResult } from "@/integrations/logistics/adapter";
import type { OrderLogisticsDetail } from "@/integrations/logistics/types";
import type { ShopifyOrderLineItem } from "@/integrations/shopify/order-detail";
import { joinLogisticsLines } from "@/modules/logistics/line-join";
import {
  deviationLabel,
  handoffLabel,
  palletScanLine,
  palletTitle,
  scheduleDisplay,
  statusLabel,
} from "@/modules/logistics/presentation";

/**
 * "Magazijn & logistiek" — everything the warehouse knows about this order,
 * read live from OfferteApp and stored nowhere (ADR-004).
 *
 * The order of the blocks follows how staff read the page: what has to
 * happen (status and handoff), when, how far picking has got, whether the
 * pallets are scanned out, and only then the supporting detail.
 */

export function WarehouseLogisticsSection({
  result,
  shopifyLines,
  hasMoreLineItems,
}: {
  result: LogisticsDetailResult;
  shopifyLines: ShopifyOrderLineItem[];
  hasMoreLineItems: boolean;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-ink-secondary">Magazijn &amp; logistiek</h2>
      {result.ok ? (
        <LogisticsDetail order={result.order} shopifyLines={shopifyLines} hasMoreLineItems={hasMoreLineItems} />
      ) : (
        <UnavailableNotice reason={result.reason} />
      )}
    </section>
  );
}

/** An integration problem is stated as one — never as an order without
 * pallets, without photos or "nog niet gepickt". */
function UnavailableNotice({ reason }: { reason: "unavailable" | "failed" | "not_found" }) {
  const text =
    reason === "not_found"
      ? "Deze order is niet bekend in OfferteApp. Er is hier dus niets over het magazijn te tonen."
      : reason === "unavailable"
        ? "OfferteApp is niet gekoppeld, dus magazijngegevens worden hier niet getoond."
        : "Logistieke gegevens tijdelijk niet beschikbaar. De rest van deze pagina klopt wel.";
  return (
    <div className="cc-card flex items-start gap-2.5 border-warning-500/30 bg-warning-50/50 p-4 text-sm text-ink-secondary">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-700" aria-hidden />
      <p>{text}</p>
    </div>
  );
}

function LogisticsDetail({
  order,
  shopifyLines,
  hasMoreLineItems,
}: {
  order: OrderLogisticsDetail;
  shopifyLines: ShopifyOrderLineItem[];
  hasMoreLineItems: boolean;
}) {
  const schedule = scheduleDisplay(order.scheduleState, order.requestedDate);
  const join = joinLogisticsLines(shopifyLines, order.lines);
  const photos = order.photos.items ?? [];

  return (
    <div className="space-y-4">
      {/* A — status & afhandeling */}
      <div className="cc-card p-4">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Status">
            <Badge tone="accent">{statusLabel(order.operationalStatus)}</Badge>
          </Field>
          <Field label="Afhandeling">
            <span className={order.handoffType === "UNKNOWN" ? "text-ink-tertiary" : "text-ink-primary"}>
              {handoffLabel(order.handoffType)}
            </span>
          </Field>
          <Field label="Gewenste datum">
            <span className={schedule.primary === "Nog geen datum" ? "text-ink-tertiary" : "text-ink-primary"}>
              {schedule.primary}
            </span>
            {schedule.secondary && <span className="block text-xs text-ink-tertiary">{schedule.secondary}</span>}
          </Field>
          <Field label="Pallets">
            {order.pallets.total === 0 ? (
              <span className="text-ink-tertiary">Geen pallets</span>
            ) : (
              <span className="tabular-nums">
                {order.pallets.scanned} / {order.pallets.total} gescand
              </span>
            )}
          </Field>
        </dl>
        {order.deliveryNote && <p className="mt-4 border-t border-border-subtle pt-3 text-sm text-ink-secondary">{order.deliveryNote}</p>}
        {order.transport && <TransportLine transport={order.transport} />}
      </div>

      {/* B — picken. Voortgang en wie ermee bezig is; nadrukkelijk geen status. */}
      <div className="cc-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink-primary">Picken</h3>
          <span className="text-sm tabular-nums text-ink-secondary">
            {order.pick.pickedLines} / {order.pick.totalLines} regels
          </span>
        </div>
        <PickProgressBar picked={order.pick.pickedLines} total={order.pick.totalLines} />
        <div className="mt-3 space-y-1 text-sm text-ink-secondary">
          {order.pick.startedAt && (
            <p>
              Gestart {formatDateTime(order.pick.startedAt)}
              {order.pick.startedByName ? ` · ${order.pick.startedByName}` : ""}
            </p>
          )}
          {order.pick.completedAt ? (
            <p>
              Afgerond {formatDateTime(order.pick.completedAt)}
              {order.pick.completedByName ? ` · ${order.pick.completedByName}` : ""}
            </p>
          ) : order.pick.started ? (
            <p>Nog niet afgerond.</p>
          ) : (
            <p className="text-ink-tertiary">Nog niet gestart.</p>
          )}
          {order.pick.deviationCount > 0 && (
            <p className="text-danger-700">
              {order.pick.deviationCount} {order.pick.deviationCount === 1 ? "regel" : "regels"} met een afwijking.
            </p>
          )}
        </div>
        {/* Een claim is een gelijktijdigheidsslot, geen status: alleen tonen
            zolang hij actief is. */}
        {order.lock.active && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-warning-50 px-3 py-2 text-sm text-warning-700">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="font-medium">
              {order.lock.claimedByName ? `Wordt nu gepickt door ${order.lock.claimedByName}` : "Wordt nu gepickt"}
            </span>
            <span className="text-xs text-ink-tertiary">
              {order.lock.claimedAt ? `sinds ${formatDateTime(order.lock.claimedAt)}` : ""}
              {order.lock.lastActivityAt ? ` · laatste actie ${formatDateTime(order.lock.lastActivityAt)}` : ""}
            </span>
          </div>
        )}
      </div>

      {/* C — pickregels, gekoppeld op line-item-id en op niets anders. */}
      <div className="cc-card overflow-hidden">
        <h3 className="border-b border-border-subtle px-4 py-3 text-sm font-medium text-ink-primary">Pickregels</h3>
        {shopifyLines.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-tertiary">Deze order heeft geen orderregels.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="text-left text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 text-right font-medium">Besteld</th>
                  <th className="px-4 py-2 text-right font-medium">Gepickt</th>
                  <th className="px-4 py-2 font-medium">Bijzonderheden</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {join.lines.map(({ shopifyLine, pick }) => (
                  <tr key={shopifyLine.gid} className="align-top">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-ink-primary">{shopifyLine.title}</p>
                      {shopifyLine.variantTitle && <p className="text-xs text-ink-tertiary">{shopifyLine.variantTitle}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{shopifyLine.currentQuantity}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {pick ? (
                        <span className={pick.picked ? "text-ink-primary" : "text-ink-tertiary"}>{pick.pickedQuantity}</span>
                      ) : (
                        <span className="text-ink-tertiary">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-ink-secondary">
                      {!pick ? (
                        <span className="text-ink-tertiary">Geen pickgegevens</span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-1.5">
                          {pick.picked ? <Badge tone="success">Gepickt</Badge> : <Badge tone="neutral">Open</Badge>}
                          {pick.deviation && <Badge tone="danger">{deviationLabel(pick.deviation)}</Badge>}
                          {pick.deviationNote && <span className="text-xs">{pick.deviationNote}</span>}
                          {pick.pickedByName && <span className="text-xs text-ink-tertiary">{pick.pickedByName}</span>}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Liever zichtbaar onopgelost dan stilletjes aan het verkeerde
            product geplakt. */}
        {join.unmatchedPickLines.length > 0 && (
          <p className="flex items-start gap-2 border-t border-border-subtle bg-warning-50/50 px-4 py-2.5 text-sm text-ink-secondary">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-700" aria-hidden />
            <span>
              {join.unmatchedPickLines.length} {join.unmatchedPickLines.length === 1 ? "pickregel hoort" : "pickregels horen"} bij
              een orderregel die hier niet staat
              {hasMoreLineItems ? " (deze order heeft meer dan 100 regels)" : ""}. Bekijk de order in de Pick App of OfferteApp.
            </span>
          </p>
        )}
      </div>

      {/* D — pallets bestaan alleen bij Van Eijk; ze worden nergens verzonnen. */}
      {order.palletDetails.length > 0 && (
        <div className="cc-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
            <h3 className="text-sm font-medium text-ink-primary">Pallets</h3>
            <span className="inline-flex items-center gap-1.5 text-sm tabular-nums text-ink-secondary">
              <ScanLine className="h-3.5 w-3.5" aria-hidden />
              {order.pallets.scanned} / {order.pallets.total} gescand
            </span>
          </div>
          <ul className="divide-y divide-border-subtle">
            {order.palletDetails.map((pallet) => (
              <li key={pallet.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                <span className="font-medium text-ink-primary">
                  {palletTitle(pallet)}
                  {pallet.unitLabel ? <span className="ml-2 text-xs font-normal text-ink-tertiary">{pallet.unitLabel}</span> : null}
                </span>
                <span className="font-mono text-xs text-ink-tertiary">{pallet.barcode}</span>
                <span className={pallet.scannedAt ? "text-ink-secondary" : "text-ink-tertiary"}>{palletScanLine(pallet)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* E — foto's horen bij de order, niet bij een pallet. */}
      {(photos.length > 0 || order.photos.pendingCount > 0 || order.photos.failedCount > 0) && (
        <div className="cc-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-primary">
              <Camera className="h-3.5 w-3.5" aria-hidden />
              Foto&apos;s van deze order
            </h3>
            {(order.photos.pendingCount > 0 || order.photos.failedCount > 0) && (
              <span className="text-xs text-ink-tertiary">
                {order.photos.pendingCount > 0 ? `${order.photos.pendingCount} bezig met uploaden` : ""}
                {order.photos.pendingCount > 0 && order.photos.failedCount > 0 ? " · " : ""}
                {order.photos.failedCount > 0 ? `${order.photos.failedCount} mislukt` : ""}
              </span>
            )}
          </div>
          {photos.length > 0 && (
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {photos.map((photo) => (
                <li key={photo.shopifyFileGid}>
                  <a
                    href={photo.url ?? photo.thumbUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="cc-focus-ring block overflow-hidden rounded-md border border-border"
                  >
                    {/* Plain <img>: deze thumbnails komen van de Shopify-CDN
                        en hoeven niet door de image-optimizer van Next heen. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.thumbUrl ?? photo.url ?? ""}
                      alt={photo.alt || "Palletfoto"}
                      loading="lazy"
                      className="aspect-square w-full bg-canvas object-cover"
                    />
                  </a>
                  {(photo.uploadedByName || photo.createdAt) && (
                    <p className="mt-1 truncate text-xs text-ink-tertiary">
                      {[photo.uploadedByName, photo.createdAt ? formatDateTime(photo.createdAt) : null].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function PickProgressBar({ picked, total }: { picked: number; total: number }) {
  const percentage = total > 0 ? Math.min(100, Math.round((picked / total) * 100)) : 0;
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas" aria-hidden>
      <div
        className={picked > 0 && picked >= total ? "h-full rounded-full bg-success-500" : "h-full rounded-full bg-accent-500"}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

/** Van Eijk and Hoefnagels return different facts; each is shown as itself,
 * and the Van Eijk pickup day is the one OfferteApp derived. */
function TransportLine({ transport }: { transport: NonNullable<OrderLogisticsDetail["transport"]> }) {
  const parts: string[] = [];
  if (transport.carrier === "VAN_EIJK") {
    if (transport.pickupDate) parts.push(`Ophalen ${formatDate(transport.pickupDate)}`);
    if (transport.deliveryDate) parts.push(`Lossen ${formatDate(transport.deliveryDate)}`);
    if (transport.palletCount) parts.push(`${transport.palletCount} pallets${transport.palletType ? ` (${transport.palletType})` : ""}`);
    if (transport.supplierNumber) parts.push(`Opdracht ${transport.supplierNumber}`);
  } else {
    if (transport.planningGroup) parts.push(transport.planningGroup);
    if (transport.deliveryDate) parts.push(`Levering ${formatDate(transport.deliveryDate)}`);
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border-subtle pt-3 text-sm text-ink-secondary">
      <PackageSearch className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" aria-hidden />
      <span className="font-medium text-ink-primary">
        {transport.carrier === "VAN_EIJK" ? "Van Eijk" : transport.carrier === "HOEFNAGELS" ? "Hoefnagels" : transport.carrier}
      </span>
      {parts.length > 0 && <span>{parts.join(" · ")}</span>}
    </div>
  );
}

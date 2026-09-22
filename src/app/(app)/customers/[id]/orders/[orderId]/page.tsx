import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { prisma } from "@/platform/db/prisma";
import { getShopifyOrderDetail } from "@/integrations/shopify/order-detail";
import { createLogisticsAdapter, type LogisticsDetailResult } from "@/integrations/logistics/adapter";
import { logisticsEventsToTimelineItems } from "@/modules/logistics/timeline";
import { customerDisplayName } from "@/modules/crm/customer-identity";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDateTime, formatMoney } from "@/lib/format";
import { ActivityTimelineView } from "../../ActivityTimelineView";
import { WarehouseLogisticsSection } from "./WarehouseLogisticsSection";

// Read-only order page. Shopify owns the order itself, OfferteApp owns
// everything about the warehouse; this page only puts the two next to each
// other. It stores nothing and writes nothing — opening it leaves both
// systems exactly as they were.

type PageProps = { params: Promise<{ id: string; orderId: string }> };

const FINANCIAL_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  PAID: "success",
  PENDING: "warning",
  PARTIALLY_PAID: "warning",
  AUTHORIZED: "warning",
  REFUNDED: "neutral",
  VOIDED: "danger",
};

export default async function CustomerOrderDetailPage({ params }: PageProps) {
  const { id, orderId } = await params;
  const user = await getSessionUser();
  if (!user) return null; // (app)/layout already redirects unauthenticated users

  if (!/^\d+$/.test(orderId)) notFound();

  const profile = await prisma.customerProfile.findUnique({ where: { id } });
  if (!profile) notFound();

  let order;
  try {
    order = await getShopifyOrderDetail(`gid://shopify/Order/${orderId}`);
  } catch {
    // Shopify owns the order itself — without it there is no page to show,
    // unlike the logistics block, which degrades in place.
    return (
      <EmptyState
        tone="error"
        title="Shopify is niet bereikbaar"
        description="Kon deze order niet ophalen bij Shopify. Probeer het later opnieuw."
      />
    );
  }
  if (!order) notFound();

  // The order has to belong to the customer whose page this is: the URL is
  // guessable, and an order read through the wrong customer would be a
  // quiet data leak between accounts.
  if (order.customerGid !== profile.shopifyCustomerGid) notFound();

  // Same fail-isolation as everywhere else in Customer 360: the adapter
  // already degrades rather than throws, and the catch is the belt to that
  // brace. Never turns into "no pallets" — see WarehouseLogisticsSection.
  let logistics: LogisticsDetailResult;
  try {
    logistics = await createLogisticsAdapter().getForOrder(orderId);
  } catch (error) {
    console.error("logistics_detail_fetch_failed", error);
    logistics = { ok: false, reason: "failed" };
  }

  const logisticsTimeline = logistics.ok ? logisticsEventsToTimelineItems(logistics.order.timeline) : [];

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Link
          href={`/customers/${id}?tab=orders`}
          className="inline-flex items-center gap-1.5 text-sm text-ink-tertiary transition-colors hover:text-ink-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {customerDisplayName(profile)}
        </Link>
        <div className="cc-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-ink-primary">Bestelling {order.name}</h1>
              <p className="mt-0.5 text-sm text-ink-tertiary">{formatDateTime(order.createdAt)}</p>
            </div>
            <a
              href={order.adminUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="cc-btn-secondary"
              title="Openen in Shopify Admin"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              Shopify Admin
            </a>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            {order.cancelledAt && <Badge tone="danger">Geannuleerd</Badge>}
            {order.displayFinancialStatus && (
              <Badge tone={FINANCIAL_TONE[order.displayFinancialStatus] ?? "neutral"}>{order.displayFinancialStatus}</Badge>
            )}
            <span className="text-ink-secondary">{order.displayFulfillmentStatus ?? "—"}</span>
            <span className="font-medium tabular-nums text-ink-primary">{formatMoney(order.currentTotalPriceSet)}</span>
          </div>
          {order.note && <p className="mt-3 border-t border-border-subtle pt-3 text-sm text-ink-secondary">{order.note}</p>}
        </div>
      </div>

      <WarehouseLogisticsSection
        result={logistics}
        shopifyLines={order.lineItems}
        hasMoreLineItems={order.hasMoreLineItems}
      />

      {/* Alleen echt vastgelegde gebeurtenissen: statuswijzigingen die staff
          met de hand op het OfferteApp-bord doet, worden nergens gelogd en
          worden hier dus ook niet verzonnen. */}
      {logisticsTimeline.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-ink-secondary">Logistieke tijdlijn</h2>
          <div className="cc-card p-4">
            <ActivityTimelineView items={logisticsTimeline} />
          </div>
        </section>
      )}
    </div>
  );
}

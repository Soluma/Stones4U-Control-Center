import "server-only";
import { prisma } from "@/platform/db/prisma";
import { createTelephonyAdapter } from "@/integrations/telephony/adapter";
import { createExactHistoryAdapter } from "@/integrations/exact/adapter";
import type { ShopifyOrderSummary } from "@/integrations/shopify/types";

// The unified Activity Timeline — combines "A" (Control-Center-owned,
// stored in the Activity table) and "B" (external, projected at render
// time, never persisted here) sources into one chronological list, per the
// adapter/projection strategy in docs/platform-discovery/24. The UI never
// needs to know which source a TimelineItem came from.

export type TimelineItem = {
  id: string;
  occurredAt: Date;
  source: "CONTROL_CENTER" | "SHOPIFY" | "TELEFOONSYSTEEM" | "EXACT";
  kind: string;
  title: string;
  summary?: string | null;
  actorName?: string | null;
};

export async function getCustomerTimeline(
  customerProfileId: string,
  context: { shopifyOrders: ShopifyOrderSummary[]; phoneNumbers: string[] },
): Promise<TimelineItem[]> {
  const ownedActivities = await prisma.activity.findMany({
    where: { customerProfileId },
    include: { actor: { select: { name: true } } },
    orderBy: { occurredAt: "desc" },
    take: 200,
  });

  const ownedItems: TimelineItem[] = ownedActivities.map((activity) => ({
    id: activity.id,
    occurredAt: activity.occurredAt,
    source: "CONTROL_CENTER",
    kind: activity.type,
    title: activity.title,
    summary: activity.summary,
    actorName: activity.actor?.name ?? null,
  }));

  // Shopify orders are projected, never persisted (see schema.prisma
  // Activity model comment) — Shopify itself remains the system of record.
  const orderItems: TimelineItem[] = context.shopifyOrders.map((order) => ({
    id: `shopify-order-${order.gid}`,
    occurredAt: new Date(order.createdAt),
    source: "SHOPIFY",
    kind: "SHOPIFY_ORDER",
    title: `Bestelling ${order.name}`,
    summary: [order.displayFinancialStatus, order.displayFulfillmentStatus].filter(Boolean).join(" · ") || null,
  }));

  // Disabled in Phase 1 (see the adapters themselves) — always returns [],
  // never throws, so the timeline degrades gracefully with no telephony/
  // Exact data rather than failing.
  const telephony = createTelephonyAdapter();
  const exact = createExactHistoryAdapter();
  const [callItems, invoiceSummary] = await Promise.all([
    telephony.getActivityForPhoneNumbers(context.phoneNumbers),
    exact.getSummaryForCustomer({}),
  ]);

  const telephonyItems: TimelineItem[] = callItems.map((call) => ({
    id: `telefoon-${call.id}`,
    occurredAt: new Date(call.occurredAt),
    source: "TELEFOONSYSTEEM",
    kind: "CALL",
    title: call.title,
    summary: call.summary ?? null,
  }));

  const invoiceItems: TimelineItem[] = invoiceSummary?.lastInvoiceAt
    ? [
        {
          id: "exact-last-invoice",
          occurredAt: new Date(invoiceSummary.lastInvoiceAt),
          source: "EXACT",
          kind: "INVOICE",
          title: "Laatste factuur (Exact)",
          summary: null,
        },
      ]
    : [];

  return [...ownedItems, ...orderItems, ...telephonyItems, ...invoiceItems].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );
}

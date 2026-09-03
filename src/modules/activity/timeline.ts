import "server-only";
import { prisma } from "@/platform/db/prisma";
import { createTelephonyAdapter } from "@/integrations/telephony/adapter";
import { createQuotesAdapter } from "@/integrations/quotes/adapter";
import { createExactHistoryAdapter } from "@/integrations/exact/adapter";
import type { ShopifyOrderSummary, ShopifyDraftOrderSummary } from "@/integrations/shopify/types";
import { stableEmailId } from "@/integrations/email/types";
import type { NormalizedEmailMessage } from "@/integrations/email/types";

// The unified Activity Timeline — combines "A" (Control-Center-owned,
// stored in the Activity table) and "B" (external, projected at render
// time, never persisted here) sources into one chronological list, per the
// adapter/projection strategy in docs/platform-discovery/24. The UI never
// needs to know which source a TimelineItem came from.

export type TimelineItem = {
  id: string;
  occurredAt: Date;
  source: "CONTROL_CENTER" | "SHOPIFY" | "TELEFOONSYSTEEM" | "EXACT" | "OFFERTEAPP" | "S4U_QUOTE_APP" | "MICROSOFT365" | "IMAP";
  kind: string;
  title: string;
  summary?: string | null;
  actorName?: string | null;
};

export async function getCustomerTimeline(
  customerProfileId: string,
  context: {
    shopifyOrders: ShopifyOrderSummary[];
    draftOrders?: ShopifyDraftOrderSummary[];
    phoneNumbers: string[];
    quoteMatchRefs?: { shopifyCustomerGid?: string; email?: string; phone?: string };
    // Phase 3C-A — fetched once by the caller (same fail-isolation pattern
    // as draftOrders/quotes, see src/app/(app)/customers/[id]/page.tsx) so
    // the Graph query and the Overview "Recente e-mails" block never issue
    // it twice.
    emailMessages?: NormalizedEmailMessage[];
  },
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

  // Phase 3a — docs/architecture/ADR-008-EXTERNAL-COMMUNICATIONS-STRATEGY.md:
  // category B, never persisted, stable synthetic ID mirroring the existing
  // shopify-order-{gid} pattern so no dedup logic is ever needed.
  const draftOrderItems: TimelineItem[] = (context.draftOrders ?? []).map((draftOrder) => ({
    id: `shopify-draftorder-${draftOrder.gid}`,
    occurredAt: new Date(draftOrder.createdAt),
    source: "SHOPIFY",
    kind: "DRAFT_ORDER_CREATED",
    title: `Conceptbestelling ${draftOrder.name}`,
    summary: draftOrder.status,
  }));

  // Degrades gracefully to [] whenever an adapter is disabled/unreachable
  // (see the adapters themselves) — the timeline never fails because an
  // external source is unavailable.
  const telephony = createTelephonyAdapter();
  const quotes = createQuotesAdapter();
  const exact = createExactHistoryAdapter();
  const [callItems, quoteItems, invoiceSummary] = await Promise.all([
    telephony.getActivityForPhoneNumbers(context.phoneNumbers),
    quotes.getQuotesForCustomer({
      customerProfileId,
      shopifyCustomerGid: context.quoteMatchRefs?.shopifyCustomerGid,
      email: context.quoteMatchRefs?.email,
      phone: context.quoteMatchRefs?.phone,
    }),
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

  // One QUOTE_CREATED event per quote — never a synthesized QUOTE_UPDATED,
  // since neither source system exposes an update history this could
  // attribute meaningfully (ADR-008: project live data, never invent
  // events the source can't actually support).
  const quoteTimelineItems: TimelineItem[] = quoteItems.map((quote) => ({
    id: `${quote.sourceSystem.toLowerCase()}-${quote.externalId}`,
    occurredAt: new Date(quote.createdAt),
    source: quote.sourceSystem,
    kind: "QUOTE_CREATED",
    title: `Offerte ${quote.displayNumber}`,
    summary: `${quote.status} · €${quote.total}`,
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

  // Phase 3C-A — docs/architecture/ADR-008-EXTERNAL-COMMUNICATIONS-STRATEGY.md:
  // category B, never persisted. Stable synthetic ID is provider-aware
  // (docs/platform-discovery/30 §8) so two mailboxes/providers can never
  // collide, mirroring the existing shopify-order-{gid}/telefoon-{id}
  // pattern.
  const emailItems: TimelineItem[] = (context.emailMessages ?? []).map((message) => emailToTimelineItem(message));

  return [...ownedItems, ...orderItems, ...draftOrderItems, ...telephonyItems, ...quoteTimelineItems, ...invoiceItems, ...emailItems].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );
}

export function emailToTimelineItem(message: NormalizedEmailMessage): TimelineItem {
  const counterpart =
    message.direction === "INBOUND"
      ? message.from.name ?? message.from.address
      : (message.to[0]?.name ?? message.to[0]?.address ?? "onbekend") + (message.to.length + message.cc.length > 1 ? ` (+${message.to.length + message.cc.length - 1})` : "");

  return {
    id: stableEmailId(message),
    occurredAt: message.occurredAt,
    source: message.provider,
    kind: message.direction === "INBOUND" ? "EMAIL_INBOUND" : "EMAIL_OUTBOUND",
    title: message.direction === "INBOUND" ? `E-mail van ${counterpart}` : `E-mail naar ${counterpart}`,
    summary: message.subject ?? message.bodyPreview ?? null,
  };
}

export type RecentActivityItem = TimelineItem & {
  customerProfileId: string;
  customerName: string | null;
};

/** Most recent Control-Center-owned activity across *all* customers, for
 * the dashboard's "recente CRM-activiteit" (docs/platform-discovery/26 §10)
 * — deliberately CONTROL_CENTER-only (no live Shopify fetch needed here,
 * unlike the per-customer timeline). */
export async function getRecentActivity(limit = 8): Promise<RecentActivityItem[]> {
  const activities = await prisma.activity.findMany({
    orderBy: { occurredAt: "desc" },
    take: limit,
    include: {
      actor: { select: { name: true } },
      customerProfile: { select: { id: true, displayName: true, companyName: true } },
    },
  });

  return activities.map((activity) => ({
    id: activity.id,
    occurredAt: activity.occurredAt,
    source: "CONTROL_CENTER",
    kind: activity.type,
    title: activity.title,
    summary: activity.summary,
    actorName: activity.actor?.name ?? null,
    customerProfileId: activity.customerProfileId,
    customerName: activity.customerProfile.displayName ?? activity.customerProfile.companyName ?? null,
  }));
}

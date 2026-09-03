import "server-only";
import { prisma } from "@/platform/db/prisma";
import { createTelephonyAdapter } from "@/integrations/telephony/adapter";
import { createQuotesAdapter } from "@/integrations/quotes/adapter";
import { createExactHistoryAdapter } from "@/integrations/exact/adapter";
import type { ShopifyOrderSummary, ShopifyDraftOrderSummary } from "@/integrations/shopify/types";
import { stableEmailId } from "@/integrations/email/types";
import type { NormalizedEmailMessage } from "@/integrations/email/types";
import { normalizeEmail } from "@/lib/email";
import { normalizeDutchPhone } from "@/lib/phone";
import { matchContactByEmail, matchContactByPhone, type ContactIdentity } from "@/modules/crm/contact-timeline";

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
    // Phase 4c — active CustomerContact rows for this customer, fetched
    // once by the caller (already needed for the Contactpersonen section
    // itself) and reused here purely for in-memory title enrichment
    // (architecture doc §12) — never a new query, never a new external call.
    contacts?: ContactIdentity[];
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

  const contacts = context.contacts ?? [];
  const telephonyItems: TimelineItem[] = callItems.map((call) => {
    const contact = call.phoneNumber ? matchContactByPhone(contacts, normalizeDutchPhone(call.phoneNumber)) : null;
    return {
      id: `telefoon-${call.id}`,
      occurredAt: new Date(call.occurredAt),
      source: "TELEFOONSYSTEEM",
      kind: "CALL",
      title: contact ? `${call.title} — ${contact.displayName}` : call.title,
      summary: call.summary ?? null,
    };
  });

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
  const emailItems: TimelineItem[] = (context.emailMessages ?? []).map((message) => emailToTimelineItem(message, contacts));

  return [...ownedItems, ...orderItems, ...draftOrderItems, ...telephonyItems, ...quoteTimelineItems, ...invoiceItems, ...emailItems].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );
}

/** `contacts` optional (defaults to none) — every existing caller that
 * doesn't yet know about Phase 4C contacts keeps working unchanged. When
 * provided, a normalized-exact match on the relevant participant's address
 * replaces the raw header name — headers are often generic/unreliable
 * ("Info", a shared mailbox display name), while a matched CustomerContact
 * name is a verified, human-entered identity (architecture doc §12). */
export function emailToTimelineItem(message: NormalizedEmailMessage, contacts: ContactIdentity[] = []): TimelineItem {
  const participant = message.direction === "INBOUND" ? message.from : message.to[0];
  const matchedContact = matchContactByEmail(contacts, participant ? normalizeEmail(participant.address) : null);
  const extraRecipientsSuffix =
    message.direction === "OUTBOUND" && message.to.length + message.cc.length > 1 ? ` (+${message.to.length + message.cc.length - 1})` : "";

  const counterpart =
    message.direction === "INBOUND"
      ? matchedContact?.displayName ?? message.from.name ?? message.from.address
      : (matchedContact?.displayName ?? message.to[0]?.name ?? message.to[0]?.address ?? "onbekend") + extraRecipientsSuffix;

  return {
    id: stableEmailId(message),
    occurredAt: message.occurredAt,
    source: message.provider,
    kind: message.direction === "INBOUND" ? "EMAIL_INBOUND" : "EMAIL_OUTBOUND",
    title: message.direction === "INBOUND" ? `E-mail van ${counterpart}` : `E-mail naar ${counterpart}`,
    summary: message.subject ?? message.bodyPreview ?? null,
  };
}

/** Phase 4a — Opportunity-scoped timeline: only Control-Center-owned
 * Activity rows linked to this opportunity (relatedOpportunityId), never a
 * simulated filter on external calls/emails/quotes (which have no
 * opportunity-level linking mechanism — architecture doc §9/build spec §5,
 * shown separately as customer-level "klantcommunicatie" on the detail
 * page instead). */
export async function getOpportunityTimeline(opportunityId: string): Promise<TimelineItem[]> {
  const activities = await prisma.activity.findMany({
    where: { relatedOpportunityId: opportunityId },
    include: { actor: { select: { name: true } } },
    orderBy: { occurredAt: "desc" },
    take: 200,
  });

  return activities.map((activity) => ({
    id: activity.id,
    occurredAt: activity.occurredAt,
    source: "CONTROL_CENTER",
    kind: activity.type,
    title: activity.title,
    summary: activity.summary,
    actorName: activity.actor?.name ?? null,
  }));
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

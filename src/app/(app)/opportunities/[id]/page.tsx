import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { prisma } from "@/platform/db/prisma";
import { getOpportunityDetail, getOpportunityAttentionContext } from "@/modules/opportunities/opportunity.service";
import { listContactsForCustomer } from "@/modules/crm/customer-contact.service";
import { getOpportunityTimeline } from "@/modules/activity/timeline";
import { createQuotesAdapter, type QuoteSummary } from "@/integrations/quotes/adapter";
import { createTelephonyAdapter, type TelephonyActivityItem } from "@/integrations/telephony/adapter";
import { createEmailAdapter } from "@/integrations/email/adapter";
import type { NormalizedEmailMessage } from "@/integrations/email/types";
import { getShopifyCustomerOrders } from "@/integrations/shopify/orders";
import { getShopifyCustomerDraftOrders } from "@/integrations/shopify/draft-orders";
import { normalizeDutchPhone } from "@/lib/phone";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { STAGE_LABEL, STATUS_LABEL, effectiveProbability } from "@/modules/opportunities/labels";
import {
  deriveNextAction,
  deriveOpportunityAttention,
  deriveQuoteAheadOfStageSignal,
  deriveShopifyOrderSignal,
  formatNextAction,
} from "@/modules/opportunities/attention";
import { Badge } from "@/components/ui/Badge";
import { Tabs } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { ActivityTimelineView } from "../../customers/[id]/ActivityTimelineView";
import { RecentCallsBlock } from "../../customers/[id]/RecentCallsBlock";
import { RecentEmailsBlock } from "../../customers/[id]/RecentEmailsBlock";
import { NotesPanel } from "../../customers/[id]/NotesPanel";
import { TasksPanel } from "../../customers/[id]/TasksPanel";
import { AppointmentsPanel } from "../../customers/[id]/AppointmentsPanel";
import { FilesPanel } from "../../customers/[id]/FilesPanel";
import { OpportunityActions } from "./OpportunityActions";
import { OpportunityCommercialLinks, type CandidateItem } from "./OpportunityCommercialLinks";
import { AttentionBadge } from "../AttentionBadge";
import { ShopifyOrderSignalBanner } from "./ShopifyOrderSignalBanner";
import { QuoteAheadOfStageBanner } from "./QuoteAheadOfStageBanner";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
};

export default async function OpportunityDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { tab = "overview" } = await searchParams;
  const user = await getSessionUser();
  if (!user) return null;

  let opportunity;
  try {
    opportunity = await getOpportunityDetail(id);
  } catch {
    notFound();
  }

  const customer = await prisma.customerProfile.findUnique({ where: { id: opportunity.customerProfileId } });
  if (!customer) notFound();

  const canEdit = user.role !== "VIEWER";
  const customerName = customer.displayName ?? customer.companyName ?? "Klant";

  // Phase 4c — read-only, no OpportunityContact relation (architecture doc
  // §9/§10 — a concrete, aantoonbaar-needed relation was never shown, so
  // this simply reuses the customer's own contact list rather than storing
  // a duplicate on Opportunity).
  const contacts = await listContactsForCustomer(customer.id);

  // Same fail-isolation pattern as Customer 360 (src/app/(app)/customers/[id]/page.tsx)
  // — a hiccup in one federated source never takes down the rest of the page.
  let quotes: QuoteSummary[] = [];
  try {
    quotes = await createQuotesAdapter().getQuotesForCustomer({
      customerProfileId: customer.id,
      shopifyCustomerGid: customer.shopifyCustomerGid,
      email: customer.email ?? undefined,
      phone: customer.phoneNormalized ?? undefined,
    });
  } catch (error) {
    console.error("opportunity_quotes_fetch_failed", error);
  }

  let draftOrders: Awaited<ReturnType<typeof getShopifyCustomerDraftOrders>>["draftOrders"] = [];
  try {
    draftOrders = (await getShopifyCustomerDraftOrders(customer.shopifyCustomerGid)).draftOrders;
  } catch (error) {
    console.error("opportunity_draft_orders_fetch_failed", error);
  }

  let orders: Awaited<ReturnType<typeof getShopifyCustomerOrders>>["orders"] = [];
  try {
    orders = (await getShopifyCustomerOrders(customer.shopifyCustomerGid)).orders;
  } catch (error) {
    console.error("opportunity_orders_fetch_failed", error);
  }

  const candidates: CandidateItem[] = [
    ...quotes.map((quote): CandidateItem => ({
      linkType: quote.sourceSystem === "OFFERTEAPP" ? "OFFERTEAPP_QUOTE" : "S4U_QUOTE_APP_QUOTE",
      externalRef: quote.externalId,
      title: `Offerte ${quote.displayNumber}`,
      subtitle: `${quote.status} · ${formatDate(quote.createdAt)}`,
      amount: `${quote.currency} ${quote.total}`,
      adminUrl: quote.adminUrl,
    })),
    ...draftOrders.map((draftOrder): CandidateItem => ({
      linkType: "SHOPIFY_DRAFT_ORDER",
      externalRef: draftOrder.gid,
      title: `Conceptbestelling ${draftOrder.name}`,
      subtitle: `${draftOrder.status} · ${formatDate(draftOrder.updatedAt)}`,
      amount: formatMoney(draftOrder.totalPriceSet),
      adminUrl: draftOrder.adminUrl,
    })),
    ...orders.map((order): CandidateItem => ({
      linkType: "SHOPIFY_ORDER",
      externalRef: order.gid,
      title: `Bestelling ${order.name}`,
      subtitle: `${order.displayFinancialStatus ?? "onbekende status"} · ${formatDate(order.createdAt)}`,
      amount: formatMoney(order.currentTotalPriceSet),
      adminUrl: order.adminUrl,
    })),
  ];

  // Phase 4B — Shopify completed-order + quote-ahead-of-stage signals
  // (architecture doc §6/§7, build spec §18-21): pure cross-references over
  // the draftOrders/orders/quotes arrays already fetched above for
  // OpportunityCommercialLinks — zero new Shopify calls. Extracted to
  // attention.ts so they're unit-tested there without a database.
  const shopifyOrderSignal = deriveShopifyOrderSignal(opportunity, draftOrders, orders);
  const quoteAheadOfStageSignal = deriveQuoteAheadOfStageSignal(opportunity, quotes.length);

  // Phase 4B — attention engine inputs not already on the Opportunity row
  // (build spec §2): next open task + last opportunity Activity. Combined
  // with the two signals above (only ever known here, on the detail page —
  // never fetched per pipeline card, build spec §20).
  const attentionContext = await getOpportunityAttentionContext(id);
  const nextAction = deriveNextAction(attentionContext.nextOpenTask);
  const attention = deriveOpportunityAttention({
    status: opportunity.status,
    archivedAt: opportunity.archivedAt,
    stage: opportunity.stage,
    expectedCloseDate: opportunity.expectedCloseDate,
    createdAt: opportunity.createdAt,
    nextAction,
    lastOpportunityActivityAt: attentionContext.lastOpportunityActivityAt,
    shopifyOrderPlacedSignal: !!shopifyOrderSignal,
    quoteAheadOfStageSignal,
  });

  const phoneNumbers = [normalizeDutchPhone(customer.phone)].filter((p): p is string => !!p);
  let recentCalls: TelephonyActivityItem[] = [];
  try {
    recentCalls = await createTelephonyAdapter().getActivityForPhoneNumbers(phoneNumbers);
  } catch (error) {
    console.error("opportunity_telephony_fetch_failed", error);
  }

  const emailAddresses = [customer.email].filter((e): e is string => !!e);
  let emailMessages: NormalizedEmailMessage[] = [];
  try {
    emailMessages = await (await createEmailAdapter()).getMessagesForAddresses(emailAddresses);
  } catch (error) {
    console.error("opportunity_email_fetch_failed", error);
  }

  const tabItems = [
    { key: "overview", label: "Overzicht" },
    { key: "activity", label: "Activiteit" },
    { key: "notes", label: "Notities" },
    { key: "tasks", label: "Taken" },
    { key: "appointments", label: "Afspraken" },
    { key: "files", label: "Bestanden" },
  ];

  return (
    <div className="space-y-5">
      <Link href="/opportunities" className="inline-flex items-center gap-1.5 text-xs text-ink-tertiary hover:text-ink-primary">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Terug naar verkoopkansen
      </Link>

      <div className="cc-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink-primary">{opportunity.title}</h1>
              <Badge tone={opportunity.status === "WON" ? "success" : opportunity.status === "LOST" ? "danger" : "neutral"}>
                {STATUS_LABEL[opportunity.status]}
              </Badge>
              {opportunity.archivedAt && <Badge tone="warning">Gearchiveerd</Badge>}
            </div>
            <p className="mt-1 text-sm text-ink-tertiary">
              <Link href={`/customers/${customer.id}`} className="text-accent-600 hover:underline">
                {customerName}
              </Link>
              {" · "}
              {STAGE_LABEL[opportunity.stage]}
            </p>
            {opportunity.description && <p className="mt-2 max-w-2xl text-sm text-ink-secondary">{opportunity.description}</p>}
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-right text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-ink-tertiary">Waarde</p>
              <p className="font-medium text-ink-primary">{formatMoney(opportunity.estimatedValue ? { amount: opportunity.estimatedValue.toString(), currencyCode: "EUR" } : null)}</p>
            </div>
            <div>
              <p className="text-xs text-ink-tertiary">Kans</p>
              <p className="font-medium text-ink-primary">{effectiveProbability(opportunity)}%</p>
            </div>
            <div>
              <p className="text-xs text-ink-tertiary">Verwachte sluiting</p>
              <p className="font-medium text-ink-primary">{opportunity.expectedCloseDate ? formatDate(opportunity.expectedCloseDate) : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-ink-tertiary">Eigenaar</p>
              <p className="font-medium text-ink-primary">{opportunity.owner.name}</p>
            </div>
          </div>
        </div>
        {opportunity.status === "LOST" && opportunity.lostReason && (
          <p className="mt-3 rounded-md bg-danger-50 px-3 py-2 text-xs text-danger-700">Reden van verlies: {opportunity.lostReason}</p>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="space-y-5">
          <Tabs items={tabItems} active={tab} hrefFor={(key) => `/opportunities/${id}?tab=${key}`} />

          {tab === "overview" && (
            <div className="space-y-5">
              <div>
                <h2 className="mb-3 text-sm font-medium text-ink-secondary">Gekoppelde offertes/bestellingen</h2>
                <OpportunityCommercialLinks opportunityId={id} canEdit={canEdit} links={opportunity.externalLinks} candidates={candidates} />
              </div>
              <div>
                <h2 className="mb-1 text-sm font-medium text-ink-secondary">Klantcommunicatie</h2>
                <p className="mb-3 text-xs text-ink-tertiary">
                  Dit toont al het recente contact met {customerName} — niet uitsluitend gesprekken/e-mails over deze specifieke verkoopkans (dat
                  onderscheid kan niet betrouwbaar gemaakt worden).
                </p>
                <div className="grid gap-5 md:grid-cols-2">
                  <RecentCallsBlock calls={recentCalls} />
                  <RecentEmailsBlock messages={emailMessages} />
                </div>
              </div>
            </div>
          )}

          {tab === "activity" && <ActivityTimelineViewSection opportunityId={id} />}
          {tab === "notes" && <NotesPanel opportunityId={id} canEdit={canEdit} />}
          {tab === "tasks" && <TasksPanel opportunityId={id} canEdit={canEdit} />}
          {tab === "appointments" && <AppointmentsPanel opportunityId={id} canEdit={canEdit} />}
          {tab === "files" && <FilesPanel opportunityId={id} canEdit={canEdit} />}
        </div>

        <div className="space-y-5">
          <OpportunityFollowUpPanel
            attention={attention}
            nextAction={nextAction}
            lastOpportunityActivityAt={attentionContext.lastOpportunityActivityAt}
            shopifyOrderSignal={shopifyOrderSignal}
            quoteAheadOfStageSignal={quoteAheadOfStageSignal}
            opportunityId={id}
            canEdit={canEdit}
          />
          <OpportunityActions
            opportunityId={id}
            stage={opportunity.stage}
            status={opportunity.status}
            ownerUserId={opportunity.ownerUserId}
            estimatedValue={opportunity.estimatedValue ? opportunity.estimatedValue.toString() : null}
            canEdit={canEdit}
          />
          <OpportunityContactsPanel customerId={customer.id} contacts={contacts} />
        </div>
      </div>
    </div>
  );
}

// Phase 4c — read-only (architecture doc §10): no "koppelen" action, no
// Opportunity-level contact relation to write. Links to Customer 360 where
// contacts are actually managed.
function OpportunityContactsPanel({
  customerId,
  contacts,
}: {
  customerId: string;
  contacts: Awaited<ReturnType<typeof listContactsForCustomer>>;
}) {
  if (contacts.length === 0) return null;

  return (
    <div className="cc-card space-y-2 p-4">
      <h2 className="text-sm font-medium text-ink-secondary">Contactpersonen bij deze klant</h2>
      <ul className="space-y-1.5 text-sm">
        {contacts.map((contact) => (
          <li key={contact.id} className="flex items-baseline justify-between gap-2">
            <span className="truncate text-ink-primary">
              {contact.displayName}
              {contact.isPrimary && <span className="ml-1 text-xs text-accent-600">(primair)</span>}
            </span>
            {contact.jobTitle && <span className="shrink-0 truncate text-xs text-ink-tertiary">{contact.jobTitle}</span>}
          </li>
        ))}
      </ul>
      <a href={`/customers/${customerId}`} className="text-xs text-accent-600 hover:underline">
        Beheren op Customer 360 →
      </a>
    </div>
  );
}

function OpportunityFollowUpPanel({
  attention,
  nextAction,
  lastOpportunityActivityAt,
  shopifyOrderSignal,
  quoteAheadOfStageSignal,
  opportunityId,
  canEdit,
}: {
  attention: ReturnType<typeof deriveOpportunityAttention>;
  nextAction: ReturnType<typeof deriveNextAction>;
  lastOpportunityActivityAt: Date | null;
  shopifyOrderSignal: { orderName: string; orderAdminUrl: string; suggestedFinalValue: string | null } | null;
  quoteAheadOfStageSignal: boolean;
  opportunityId: string;
  canEdit: boolean;
}) {
  // BLUE signals (Shopify/quote) render as their own dedicated banners
  // below, not duplicated in the plain reasons list.
  const listReasons = attention.reasons.filter((r) => r.severity !== "BLUE");

  return (
    <div className="cc-card space-y-3 p-4">
      <h2 className="text-sm font-medium text-ink-secondary">Opvolging</h2>

      {listReasons.length === 0 ? (
        <p className="text-sm text-ink-tertiary">Geen bijzonderheden.</p>
      ) : (
        <ul className="space-y-1.5">
          {listReasons.map((reason) => (
            <li key={reason.code}>
              <AttentionBadge severity={reason.severity} primaryReason={reason} />
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1 border-t border-border-subtle pt-3 text-xs">
        <p className="text-ink-tertiary">
          Volgende actie: <span className="text-ink-secondary">{formatNextAction(nextAction, formatDate)}</span>
        </p>
        <p className="text-ink-tertiary">
          Laatste activiteit op deze verkoopkans:{" "}
          <span className="text-ink-secondary">{lastOpportunityActivityAt ? formatDateTime(lastOpportunityActivityAt) : "—"}</span>
        </p>
      </div>

      {shopifyOrderSignal && (
        <ShopifyOrderSignalBanner
          opportunityId={opportunityId}
          orderName={shopifyOrderSignal.orderName}
          orderAdminUrl={shopifyOrderSignal.orderAdminUrl}
          suggestedFinalValue={shopifyOrderSignal.suggestedFinalValue}
          canEdit={canEdit}
        />
      )}
      {quoteAheadOfStageSignal && <QuoteAheadOfStageBanner opportunityId={opportunityId} canEdit={canEdit} />}
    </div>
  );
}

async function ActivityTimelineViewSection({ opportunityId }: { opportunityId: string }) {
  const items = await getOpportunityTimeline(opportunityId);
  if (items.length === 0) {
    return <EmptyState title="Nog geen activiteit" description="Zodra deze verkoopkans wijzigt (fase, taken, notities…) verschijnt dat hier." />;
  }
  return <ActivityTimelineView items={items} />;
}

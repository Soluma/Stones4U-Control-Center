import { notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/platform/auth/session";
import { getCustomer360 } from "@/modules/crm/customer-profile.service";
import { getCustomerTimeline } from "@/modules/activity/timeline";
import { listTasksForCustomer } from "@/modules/tasks/task.service";
import { listAppointmentsForCustomer } from "@/modules/appointments/appointment.service";
import { listFilesForCustomer } from "@/modules/files/file.service";
import { listTagsForCustomer, listCustomerTags } from "@/modules/crm/customer-tag.service";
import { getShopifyCustomerDraftOrders } from "@/integrations/shopify/draft-orders";
import { createTelephonyAdapter, type TelephonyActivityItem } from "@/integrations/telephony/adapter";
import { createQuotesAdapter, type QuoteSummary } from "@/integrations/quotes/adapter";
import { createEmailAdapter } from "@/integrations/email/adapter";
import type { NormalizedEmailMessage } from "@/integrations/email/types";
import { listOpportunitiesForCustomer } from "@/modules/opportunities/opportunity.service";
import { prisma } from "@/platform/db/prisma";
import { normalizeDutchPhone } from "@/lib/phone";
import { formatDate, formatDateTime } from "@/lib/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { CustomerHeader } from "./CustomerHeader";
import { OrdersTable } from "./OrdersTable";
import { DraftOrdersTable } from "./DraftOrdersTable";
import { QuotesTable } from "./QuotesTable";
import { RecentCallsBlock } from "./RecentCallsBlock";
import { RecentEmailsBlock } from "./RecentEmailsBlock";
import { OpenOpportunitiesBlock } from "./OpenOpportunitiesBlock";
import { OpportunitiesSection } from "./OpportunitiesSection";
import { ActivityTimelineView } from "./ActivityTimelineView";
import { AdapterStatusBanner } from "./AdapterStatusBanner";
import { NotesPanel } from "./NotesPanel";
import { TasksPanel } from "./TasksPanel";
import { AppointmentsPanel } from "./AppointmentsPanel";
import { FilesPanel } from "./FilesPanel";
import type { ShopifyDraftOrderSummary } from "@/integrations/shopify/types";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
};

export default async function CustomerDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { tab = "overview" } = await searchParams;
  const user = await getSessionUser();
  if (!user) return null; // (app)/layout already redirects unauthenticated users

  let data;
  try {
    data = await getCustomer360(id);
  } catch {
    // Shopify is the identity source — a failure here is surfaced clearly,
    // per docs/platform-discovery/25 §8, rather than silently hidden.
    return (
      <EmptyState
        title="Shopify is niet bereikbaar"
        description="Kon de klantgegevens niet ophalen bij Shopify. Probeer het later opnieuw."
      />
    );
  }

  if (!data) notFound();

  const canEdit = user.role !== "VIEWER";
  const tabItems = [
    { key: "overview", label: "Overzicht" },
    // Key stays "orders" (URL/bookmark-compatible with Phase 2) — label
    // renamed per docs/platform-discovery/28-PHASE-3-ARCHITECTURE.md §4:
    // one "Commercieel" tab with Orders + Concept-orders sub-sections
    // instead of a new top-level tab.
    { key: "orders", label: "Commercieel" },
    { key: "activity", label: "Activiteit" },
    { key: "notes", label: "Notities" },
    { key: "tasks", label: "Taken" },
    { key: "appointments", label: "Afspraken" },
    { key: "files", label: "Bestanden" },
  ];

  const [tags, allTags, managers] = await Promise.all([
    listTagsForCustomer(id),
    listCustomerTags(),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  // Phase 3a — docs/platform-discovery/28-PHASE-3-ARCHITECTURE.md §4. Fetched
  // once here (not per-tab) so the Commercieel tab and the Timeline/Overview
  // draft-order projection never issue two separate Shopify calls. Its own
  // try/catch, deliberately outside the Promise.all above: a draft-order
  // hiccup must not take down tags/managers, and vice versa (build spec §2
  // fail-safe requirement) — degrades to "unavailable", never a page crash.
  let draftOrders: ShopifyDraftOrderSummary[] | null = null;
  let draftOrdersUnavailable = false;
  try {
    draftOrders = (await getShopifyCustomerDraftOrders(data.profile.shopifyCustomerGid)).draftOrders;
  } catch (error) {
    console.error("draft_orders_fetch_failed", error);
    draftOrdersUnavailable = true;
  }

  const phoneNumbers = [normalizeDutchPhone(data.profile.phone)].filter((p): p is string => !!p);
  const quoteMatchRefs = {
    shopifyCustomerGid: data.profile.shopifyCustomerGid,
    email: data.profile.email ?? undefined,
    phone: data.profile.phoneNormalized ?? undefined,
  };

  // Phase 3b — fetched once here (not per-tab), same fail-isolation pattern
  // as draftOrders above: a telephony/quotes hiccup must not take down the
  // rest of Customer 360, and vice versa.
  let quotes: QuoteSummary[] = [];
  try {
    quotes = await createQuotesAdapter().getQuotesForCustomer({ customerProfileId: id, ...quoteMatchRefs });
  } catch (error) {
    console.error("quotes_fetch_failed", error);
  }

  let recentCalls: TelephonyActivityItem[] = [];
  try {
    recentCalls = await createTelephonyAdapter().getActivityForPhoneNumbers(phoneNumbers);
  } catch (error) {
    console.error("telephony_fetch_failed", error);
  }

  // Phase 3C-A — same fail-isolation pattern as quotes/recentCalls above; a
  // Graph/mailbox hiccup must not take down the rest of Customer 360.
  const emailAddresses = [data.profile.email].filter((e): e is string => !!e);
  let emailMessages: NormalizedEmailMessage[] = [];
  try {
    emailMessages = await (await createEmailAdapter()).getMessagesForAddresses(emailAddresses);
  } catch (error) {
    console.error("email_fetch_failed", error);
  }

  // Phase 4a — same fail-isolation pattern as the other federated/derived
  // fetches above; an opportunity-lookup hiccup must not take down the rest
  // of Customer 360.
  let openOpportunities: Awaited<ReturnType<typeof listOpportunitiesForCustomer>> = [];
  try {
    openOpportunities = await listOpportunitiesForCustomer(id, { archived: "exclude" });
  } catch (error) {
    console.error("opportunities_fetch_failed", error);
  }
  const openCount = openOpportunities.filter((o) => o.status === "OPEN").length;

  return (
    <div className="space-y-5">
      <CustomerHeader
        data={data}
        viewerRole={user.role}
        id={id}
        tags={tags}
        allTags={allTags}
        managers={managers}
        openOpportunitiesCount={openCount}
      />
      <Tabs items={tabItems} active={tab} hrefFor={(key) => `/customers/${id}?tab=${key}`} />

      {tab === "overview" && (
        <OverviewTab
          id={id}
          shopifyOrders={data.orders.orders}
          draftOrders={draftOrders}
          phoneNumbers={phoneNumbers}
          quoteMatchRefs={quoteMatchRefs}
          recentCalls={recentCalls}
          emailMessages={emailMessages}
          openOpportunities={openOpportunities.filter((o) => o.status === "OPEN")}
        />
      )}

      {tab === "orders" && (
        <CommercialTab
          id={id}
          customerName={data.shopify.displayName}
          orders={data.orders.orders}
          draftOrders={draftOrders}
          draftOrdersUnavailable={draftOrdersUnavailable}
          quotes={quotes}
          canEdit={canEdit}
        />
      )}

      {tab === "activity" && (
        <div className="space-y-3">
          <AdapterStatusBanner />
          <ActivityTimelineView
            items={await getCustomerTimeline(id, {
              shopifyOrders: data.orders.orders,
              draftOrders: draftOrders ?? [],
              phoneNumbers,
              quoteMatchRefs,
              emailMessages,
            })}
          />
        </div>
      )}

      {tab === "notes" && <NotesPanel customerId={id} canEdit={canEdit} />}
      {tab === "tasks" && <TasksPanel customerId={id} canEdit={canEdit} />}
      {tab === "appointments" && <AppointmentsPanel customerId={id} canEdit={canEdit} />}
      {tab === "files" && <FilesPanel customerId={id} canEdit={canEdit} />}
    </div>
  );
}

function CommercialTab({
  id,
  customerName,
  orders,
  draftOrders,
  draftOrdersUnavailable,
  quotes,
  canEdit,
}: {
  id: string;
  customerName: string;
  orders: Parameters<typeof OrdersTable>[0]["orders"];
  draftOrders: ShopifyDraftOrderSummary[] | null;
  draftOrdersUnavailable: boolean;
  quotes: QuoteSummary[];
  canEdit: boolean;
}) {
  return (
    <div className="space-y-6">
      <OpportunitiesSection customerId={id} customerName={customerName} canCreate={canEdit} />
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-ink-secondary">Bestellingen</h2>
        <OrdersTable orders={orders} />
      </div>
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-ink-secondary">Conceptbestellingen</h2>
        <DraftOrdersTable draftOrders={draftOrders} unavailable={draftOrdersUnavailable} />
      </div>
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-ink-secondary">Offertes</h2>
        <QuotesTable quotes={quotes} />
      </div>
    </div>
  );
}

async function OverviewTab({
  id,
  shopifyOrders,
  draftOrders,
  phoneNumbers,
  quoteMatchRefs,
  recentCalls,
  emailMessages,
  openOpportunities,
}: {
  id: string;
  shopifyOrders: Parameters<typeof getCustomerTimeline>[1]["shopifyOrders"];
  draftOrders: ShopifyDraftOrderSummary[] | null;
  phoneNumbers: string[];
  quoteMatchRefs: { shopifyCustomerGid?: string; email?: string; phone?: string };
  recentCalls: TelephonyActivityItem[];
  emailMessages: NormalizedEmailMessage[];
  openOpportunities: Awaited<ReturnType<typeof listOpportunitiesForCustomer>>;
}) {
  const [timeline, tasks, appointments, files] = await Promise.all([
    getCustomerTimeline(id, { shopifyOrders, draftOrders: draftOrders ?? [], phoneNumbers, quoteMatchRefs, emailMessages }),
    listTasksForCustomer(id),
    listAppointmentsForCustomer(id),
    listFilesForCustomer(id),
  ]);

  const openTasks = tasks.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS" || t.status === "WAITING").slice(0, 5);
  const upcomingAppointments = appointments.filter((a) => a.status === "SCHEDULED" && new Date(a.startsAt) >= new Date()).slice(0, 5);
  const recentFiles = files.slice(0, 5);

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-ink-secondary">Recente orders</h2>
        <OrdersTable orders={shopifyOrders.slice(0, 5)} />
      </div>
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-ink-secondary">Recente activiteit</h2>
        <ActivityTimelineView items={timeline.slice(0, 6)} />
      </div>
      <RecentCallsBlock calls={recentCalls} />
      <RecentEmailsBlock messages={emailMessages} />
      <OpenOpportunitiesBlock
        opportunities={openOpportunities.map((o) => ({
          id: o.id,
          title: o.title,
          stage: o.stage,
          estimatedValue: o.estimatedValue ? o.estimatedValue.toString() : null,
          probability: o.probability,
          expectedCloseDate: o.expectedCloseDate ? o.expectedCloseDate.toISOString() : null,
        }))}
      />
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-ink-secondary">Openstaande taken</h2>
        {openTasks.length === 0 ? (
          <p className="cc-card p-4 text-sm text-ink-tertiary">Geen openstaande taken.</p>
        ) : (
          <div className="cc-card divide-y divide-border-subtle">
            {openTasks.map((task) => (
              <Link key={task.id} href={`/tasks/${task.id}`} className="cc-table-row block px-4 py-2.5 text-sm">
                <p className="truncate font-medium text-ink-primary">{task.title}</p>
                <p className="mt-0.5 text-xs text-ink-tertiary">{task.assignedTo.name}{task.dueAt ? ` · ${formatDate(task.dueAt)}` : ""}</p>
              </Link>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-ink-secondary">Komende afspraken</h2>
        {upcomingAppointments.length === 0 ? (
          <p className="cc-card p-4 text-sm text-ink-tertiary">Geen komende afspraken.</p>
        ) : (
          <div className="cc-card divide-y divide-border-subtle">
            {upcomingAppointments.map((appointment) => (
              <div key={appointment.id} className="px-4 py-2.5 text-sm">
                <p className="truncate font-medium text-ink-primary">{appointment.title}</p>
                <p className="mt-0.5 text-xs text-ink-tertiary">{formatDateTime(appointment.startsAt)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      {recentFiles.length > 0 && (
        <div className="space-y-3 md:col-span-2">
          <h2 className="text-sm font-medium text-ink-secondary">Recente bestanden</h2>
          <div className="cc-card divide-y divide-border-subtle">
            {recentFiles.map((file) => (
              <div key={file.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="truncate font-medium text-ink-primary">{file.title || file.originalFilename}</span>
                <span className="shrink-0 text-xs text-ink-tertiary">{formatDate(file.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

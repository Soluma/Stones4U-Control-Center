import { notFound } from "next/navigation";
import { getSessionUser } from "@/platform/auth/session";
import { getCustomer360 } from "@/modules/crm/customer-profile.service";
import { getCustomerTimeline } from "@/modules/activity/timeline";
import { normalizeDutchPhone } from "@/lib/phone";
import { EmptyState } from "@/components/ui/EmptyState";
import { CustomerHeader } from "./CustomerHeader";
import { Tabs } from "./Tabs";
import { OrdersTable } from "./OrdersTable";
import { ActivityTimelineView } from "./ActivityTimelineView";
import { AdapterStatusBanner } from "./AdapterStatusBanner";
import { NotesPanel } from "./NotesPanel";
import { TasksPanel } from "./TasksPanel";

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

  return (
    <div className="space-y-5">
      <CustomerHeader data={data} viewerRole={user.role} />
      <Tabs customerId={id} active={tab} />

      {tab === "overview" && (
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-ink-secondary">Recente orders</h2>
            <OrdersTable orders={data.orders.orders.slice(0, 5)} />
          </div>
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-ink-secondary">Recente activiteit</h2>
            <ActivityTimelineView
              items={(
                await getCustomerTimeline(id, {
                  shopifyOrders: data.orders.orders,
                  phoneNumbers: [normalizeDutchPhone(data.profile.phone)].filter((p): p is string => !!p),
                })
              ).slice(0, 6)}
            />
          </div>
        </div>
      )}

      {tab === "orders" && <OrdersTable orders={data.orders.orders} />}

      {tab === "activity" && (
        <div className="space-y-3">
          <AdapterStatusBanner />
          <ActivityTimelineView
            items={await getCustomerTimeline(id, {
              shopifyOrders: data.orders.orders,
              phoneNumbers: [normalizeDutchPhone(data.profile.phone)].filter((p): p is string => !!p),
            })}
          />
        </div>
      )}

      {tab === "notes" && <NotesPanel customerId={id} canEdit={canEdit} />}

      {tab === "tasks" && <TasksPanel customerId={id} canEdit={canEdit} />}
    </div>
  );
}

import { notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/platform/auth/session";
import { getCustomer360 } from "@/modules/crm/customer-profile.service";
import { getCustomerTimeline } from "@/modules/activity/timeline";
import { listTasksForCustomer } from "@/modules/tasks/task.service";
import { listAppointmentsForCustomer } from "@/modules/appointments/appointment.service";
import { listFilesForCustomer } from "@/modules/files/file.service";
import { listTagsForCustomer, listCustomerTags } from "@/modules/crm/customer-tag.service";
import { prisma } from "@/platform/db/prisma";
import { normalizeDutchPhone } from "@/lib/phone";
import { formatDate, formatDateTime } from "@/lib/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { CustomerHeader } from "./CustomerHeader";
import { OrdersTable } from "./OrdersTable";
import { ActivityTimelineView } from "./ActivityTimelineView";
import { AdapterStatusBanner } from "./AdapterStatusBanner";
import { NotesPanel } from "./NotesPanel";
import { TasksPanel } from "./TasksPanel";
import { AppointmentsPanel } from "./AppointmentsPanel";
import { FilesPanel } from "./FilesPanel";

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
    { key: "orders", label: "Orders" },
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

  return (
    <div className="space-y-5">
      <CustomerHeader data={data} viewerRole={user.role} id={id} tags={tags} allTags={allTags} managers={managers} />
      <Tabs items={tabItems} active={tab} hrefFor={(key) => `/customers/${id}?tab=${key}`} />

      {tab === "overview" && (
        <OverviewTab
          id={id}
          shopifyOrders={data.orders.orders}
          phoneNumbers={[normalizeDutchPhone(data.profile.phone)].filter((p): p is string => !!p)}
        />
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
      {tab === "appointments" && <AppointmentsPanel customerId={id} canEdit={canEdit} />}
      {tab === "files" && <FilesPanel customerId={id} canEdit={canEdit} />}
    </div>
  );
}

async function OverviewTab({
  id,
  shopifyOrders,
  phoneNumbers,
}: {
  id: string;
  shopifyOrders: Parameters<typeof getCustomerTimeline>[1]["shopifyOrders"];
  phoneNumbers: string[];
}) {
  const [timeline, tasks, appointments, files] = await Promise.all([
    getCustomerTimeline(id, { shopifyOrders, phoneNumbers }),
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

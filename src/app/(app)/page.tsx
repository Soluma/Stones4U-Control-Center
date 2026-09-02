import Link from "next/link";
import { Search, Users, CalendarClock } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { TaskSummaryWidget } from "@/components/dashboard/TaskSummaryWidget";
import { listUpcomingAppointments } from "@/modules/appointments/appointment.service";
import { getRecentActivity } from "@/modules/activity/timeline";
import { formatDateTime } from "@/lib/format";

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) return null;
  const firstName = user.name.split(" ")[0];

  const [appointments, recentActivity] = await Promise.all([
    listUpcomingAppointments(user, 5),
    getRecentActivity(8),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Goedendag{firstName ? `, ${firstName}` : ""}</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Een overzicht van je taken en klantactiviteit.</p>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-ink-secondary">Taken</h2>
        <TaskSummaryWidget />
      </section>

      <section className="grid gap-5 md:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-medium text-ink-secondary">Komende afspraken</h2>
          {appointments.length === 0 ? (
            <p className="cc-card p-4 text-sm text-ink-tertiary">Geen komende afspraken.</p>
          ) : (
            <div className="cc-card divide-y divide-border-subtle">
              {appointments.map((appointment) => (
                <Link
                  key={appointment.id}
                  href={`/customers/${appointment.customerProfile.id}?tab=appointments`}
                  className="cc-table-row flex items-center gap-3 px-4 py-2.5 text-sm"
                >
                  <CalendarClock className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink-primary">{appointment.title}</span>
                    <span className="block truncate text-xs text-ink-tertiary">
                      {appointment.customerProfile.displayName ?? appointment.customerProfile.companyName ?? "Klant"} · {formatDateTime(appointment.startsAt)}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-3 text-sm font-medium text-ink-secondary">Recente CRM-activiteit</h2>
          {recentActivity.length === 0 ? (
            <p className="cc-card p-4 text-sm text-ink-tertiary">Nog geen activiteit.</p>
          ) : (
            <div className="cc-card divide-y divide-border-subtle">
              {recentActivity.map((item) => (
                <Link key={item.id} href={`/customers/${item.customerProfileId}`} className="cc-table-row block px-4 py-2.5 text-sm">
                  <span className="block truncate font-medium text-ink-primary">{item.title}</span>
                  <span className="block truncate text-xs text-ink-tertiary">
                    {item.customerName ?? "Klant"} · {formatDateTime(item.occurredAt)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="cc-card flex items-center justify-between gap-4 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
            <Search className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-medium text-ink-primary">Klant opzoeken</p>
            <p className="text-sm text-ink-tertiary">
              Gebruik <kbd className="rounded border border-border bg-canvas px-1.5 py-0.5 text-[10px]">⌘K</kbd> voor
              snel zoeken, of open het volledige overzicht.
            </p>
          </div>
        </div>
        <Link href="/customers" className="cc-btn-secondary shrink-0">
          <Users className="h-3.5 w-3.5" aria-hidden />
          Klanten
        </Link>
      </section>
    </div>
  );
}

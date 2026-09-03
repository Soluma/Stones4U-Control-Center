import Link from "next/link";
import { Search, Users, CalendarClock, TrendingUp, AlertCircle, Clock } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { TaskSummaryWidget } from "@/components/dashboard/TaskSummaryWidget";
import { listUpcomingAppointments } from "@/modules/appointments/appointment.service";
import { getRecentActivity } from "@/modules/activity/timeline";
import { getSalesDashboardMetrics } from "@/modules/opportunities/dashboard";
import { formatDateTime, formatMoney } from "@/lib/format";
import { customerDisplayName } from "@/modules/crm/customer-identity";

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) return null;
  const firstName = user.name.split(" ")[0];

  // "Mijn verkoopkansen"-standaard voor AGENT/USER, ADMIN ziet iedereen —
  // zelfde default als de pipeline-eigenaarfilter (architectuurdoc §14).
  const [appointments, recentActivity, salesMetrics] = await Promise.all([
    listUpcomingAppointments(user, 5),
    getRecentActivity(8),
    getSalesDashboardMetrics(user.role === "ADMIN" ? {} : { ownerUserId: user.id }),
  ]);
  const money = (amount: string) => formatMoney({ amount, currencyCode: "EUR" });

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
                      {customerDisplayName(appointment.customerProfile)} · {formatDateTime(appointment.startsAt)}
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

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-secondary">
            Verkoop{user.role !== "ADMIN" ? " — mijn verkoopkansen" : ""}
          </h2>
          <Link href="/opportunities" className="text-xs font-medium text-accent-600 hover:underline">
            Volledige pijplijn →
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="cc-card p-4">
            <p className="text-xs text-ink-tertiary">Open pijplijn</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-ink-primary">{money(salesMetrics.openPipelineValue)}</p>
            <p className="mt-0.5 text-xs text-ink-tertiary">gewogen {money(salesMetrics.weightedPipelineValue)}</p>
          </div>
          <Link href="/opportunities" className="cc-card cc-table-row p-4">
            <p className="flex items-center gap-1.5 text-xs text-ink-tertiary">
              <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Aandacht nodig
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-ink-primary">{salesMetrics.attentionCount}</p>
            <p className="mt-0.5 text-xs text-ink-tertiary">{salesMetrics.overdueFollowUpsCount} achterstallig</p>
          </Link>
          <div className="cc-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-ink-tertiary">
              <Clock className="h-3.5 w-3.5" aria-hidden /> Verwachte sluiting
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-ink-primary">{salesMetrics.expectedClosesNext30DaysCount}</p>
            <p className="mt-0.5 text-xs text-ink-tertiary">komende 30 dagen</p>
          </div>
          <div className="cc-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-ink-tertiary">
              <TrendingUp className="h-3.5 w-3.5" aria-hidden /> Deze maand
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-ink-primary">
              {salesMetrics.wonThisMonthCount} gewonnen
            </p>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              {money(salesMetrics.wonThisMonthValue)} · {salesMetrics.lostThisMonthCount} verloren
            </p>
          </div>
        </div>

        {(salesMetrics.recentWon.length > 0 || salesMetrics.recentLost.length > 0) && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {salesMetrics.recentWon.length > 0 && (
              <div className="cc-card divide-y divide-border-subtle">
                <p className="px-4 py-2 text-xs font-medium text-ink-tertiary">Recent gewonnen</p>
                {salesMetrics.recentWon.slice(0, 4).map((o) => (
                  <Link key={o.id} href={`/opportunities/${o.id}`} className="cc-table-row flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate text-ink-primary">{o.title}</span>
                    <span className="shrink-0 tabular-nums text-ink-tertiary">{o.value ? money(o.value) : "—"}</span>
                  </Link>
                ))}
              </div>
            )}
            {salesMetrics.recentLost.length > 0 && (
              <div className="cc-card divide-y divide-border-subtle">
                <p className="px-4 py-2 text-xs font-medium text-ink-tertiary">Recent verloren</p>
                {salesMetrics.recentLost.slice(0, 4).map((o) => (
                  <Link key={o.id} href={`/opportunities/${o.id}`} className="cc-table-row flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate text-ink-primary">{o.title}</span>
                    <span className="shrink-0 tabular-nums text-ink-tertiary">{o.value ? money(o.value) : "—"}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
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

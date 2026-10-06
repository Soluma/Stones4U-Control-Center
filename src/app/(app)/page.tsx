import Link from "next/link";
import { Search, CalendarClock, TrendingUp, AlertCircle, Clock, Wallet } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { TaskSummaryWidget } from "@/components/dashboard/TaskSummaryWidget";
import { MyWorkTasksList } from "@/components/dashboard/MyWorkTasksList";
import { MyWorkAppointmentsList } from "@/components/dashboard/MyWorkAppointmentsList";
import { MyWorkOpportunitiesList } from "@/components/dashboard/MyWorkOpportunitiesList";
import { listUpcomingAppointments } from "@/modules/appointments/appointment.service";
import { getSalesDashboardMetrics } from "@/modules/opportunities/dashboard";
import { getMyWorkTasks, getMyWorkAppointments, getMyWorkOpportunityAttention, type MyWorkTask, type MyWorkAppointment, type MyWorkOpportunity } from "@/modules/dashboard/my-work";
import { formatDateTime, formatMoney } from "@/lib/format";
import { customerDisplayName } from "@/modules/crm/customer-identity";

// Hoofddashboard: eerst het eigen werk (Mijn Werk), dan compacte totalen en
// de komende afspraken, verkoop onderaan. Historische klantactiviteit staat
// bewust niet op het dashboard — die hoort in Customer 360 en de
// Activiteit-tab — en wordt hier dus ook niet opgehaald.
export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) return null;
  const firstName = user.name.split(" ")[0];

  // "Mijn verkoopkansen"-standaard voor AGENT/USER, ADMIN ziet iedereen —
  // zelfde default als de pipeline-eigenaarfilter (architectuurdoc §14).
  const [appointments, salesMetrics] = await Promise.all([
    listUpcomingAppointments(user, 5),
    getSalesDashboardMetrics(user.role === "ADMIN" ? {} : { ownerUserId: user.id }),
  ]);
  const money = (amount: string) => formatMoney({ amount, currencyCode: "EUR" });

  // Phase 6A — "Mijn Werk" (docs/build/PHASE-6A-MY-WORK-STAGING.md). Always
  // scoped to the signed-in actor, including ADMIN — never a team-wide view.
  // Each block is independently fail-isolated: a failure in one must never
  // take down the rest of the dashboard or the other two Mijn Werk blocks.
  const [myWorkTasks, myWorkAppointments, myWorkOpportunities] = await Promise.all([
    getMyWorkTasks(user).catch((error) => {
      console.error("my_work_tasks_failed", error);
      return [] as MyWorkTask[];
    }),
    getMyWorkAppointments(user).catch((error) => {
      console.error("my_work_appointments_failed", error);
      return [] as MyWorkAppointment[];
    }),
    getMyWorkOpportunityAttention(user).catch((error) => {
      console.error("my_work_opportunities_failed", error);
      return [] as MyWorkOpportunity[];
    }),
  ]);

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Goedendag{firstName ? `, ${firstName}` : ""}</h1>
          <p className="mt-1 text-sm text-ink-tertiary">Je werk voor vandaag, je taken en je verkoop in één overzicht.</p>
        </div>
        <Link href="/customers" className="cc-btn-secondary shrink-0" title="Snel zoeken met ⌘K / Ctrl+K">
          <Search className="h-3.5 w-3.5" aria-hidden />
          Klant zoeken
          <kbd className="ml-1 hidden rounded border border-border bg-canvas px-1.5 py-0.5 text-[10px] text-ink-tertiary sm:inline">⌘K</kbd>
        </Link>
      </header>

      <section aria-labelledby="dash-my-work" data-testid="dashboard-my-work">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="dash-my-work" className="text-base font-semibold text-ink-primary">
            Mijn Werk
          </h2>
          <Link href="/customers?scope=mine" className="text-xs font-medium text-accent-600 hover:underline">
            Mijn klanten →
          </Link>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          <MyWorkTasksList tasks={myWorkTasks} />
          <MyWorkAppointmentsList appointments={myWorkAppointments} />
          <MyWorkOpportunitiesList opportunities={myWorkOpportunities} />
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-3" data-testid="dashboard-overview">
        <div className="min-w-0">
          <h2 className="mb-3 text-sm font-medium text-ink-secondary">Mijn taken in cijfers</h2>
          <TaskSummaryWidget />
        </div>

        <div className="min-w-0 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-secondary">Komende afspraken</h2>
            {user.role === "ADMIN" && <span className="text-xs text-ink-tertiary">hele team</span>}
          </div>
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
      </section>

      <section aria-labelledby="dash-sales" data-testid="dashboard-sales">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="dash-sales" className="text-sm font-medium text-ink-secondary">
            Verkoop{user.role !== "ADMIN" ? " — mijn verkoopkansen" : ""}
          </h2>
          <Link href="/opportunities" className="text-xs font-medium text-accent-600 hover:underline">
            Volledige pijplijn →
          </Link>
        </div>
        <div className="cc-card grid grid-cols-2 lg:grid-cols-4 [&>*]:border-border-subtle [&>*:nth-child(odd)]:border-r [&>*:nth-child(-n+2)]:border-b lg:[&>*:nth-child(-n+2)]:border-b-0 lg:[&>*:not(:last-child)]:border-r">
          <div className="min-w-0 p-4">
            <p className="flex items-center gap-1.5 text-xs text-ink-tertiary">
              <Wallet className="h-3.5 w-3.5" aria-hidden /> Open pijplijn
            </p>
            <p className="mt-1 truncate text-lg font-semibold tabular-nums text-ink-primary">{money(salesMetrics.openPipelineValue)}</p>
            <p className="mt-0.5 truncate text-xs text-ink-tertiary">gewogen {money(salesMetrics.weightedPipelineValue)}</p>
          </div>
          <Link href="/opportunities" className="cc-table-row min-w-0 p-4">
            <p className="flex items-center gap-1.5 text-xs text-ink-tertiary">
              <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Aandacht nodig
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-ink-primary">{salesMetrics.attentionCount}</p>
            <p className="mt-0.5 truncate text-xs text-ink-tertiary">{salesMetrics.overdueFollowUpsCount} achterstallig</p>
          </Link>
          <div className="min-w-0 p-4">
            <p className="flex items-center gap-1.5 text-xs text-ink-tertiary">
              <Clock className="h-3.5 w-3.5" aria-hidden /> Verwachte sluiting
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-ink-primary">{salesMetrics.expectedClosesNext30DaysCount}</p>
            <p className="mt-0.5 truncate text-xs text-ink-tertiary">komende 30 dagen</p>
          </div>
          <div className="min-w-0 p-4">
            <p className="flex items-center gap-1.5 text-xs text-ink-tertiary">
              <TrendingUp className="h-3.5 w-3.5" aria-hidden /> Deze maand
            </p>
            <p className="mt-1 truncate text-lg font-semibold tabular-nums text-ink-primary">{salesMetrics.wonThisMonthCount} gewonnen</p>
            <p className="mt-0.5 truncate text-xs text-ink-tertiary">
              {money(salesMetrics.wonThisMonthValue)} · {salesMetrics.lostThisMonthCount} verloren
            </p>
          </div>
        </div>

        {(salesMetrics.recentWon.length > 0 || salesMetrics.recentLost.length > 0) && (
          <div className="mt-5 grid gap-5 md:grid-cols-2">
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
    </div>
  );
}

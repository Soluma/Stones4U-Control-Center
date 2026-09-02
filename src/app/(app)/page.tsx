import Link from "next/link";
import { Search, Users } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { TaskSummaryWidget } from "@/components/dashboard/TaskSummaryWidget";

export default async function DashboardPage() {
  const user = await getSessionUser();
  const firstName = user?.name.split(" ")[0];

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

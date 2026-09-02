import Link from "next/link";
import { getSessionUser } from "@/platform/auth/session";
import { TaskSummaryWidget } from "@/components/dashboard/TaskSummaryWidget";

export default async function DashboardPage() {
  const user = await getSessionUser();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">
          Goedendag, {user?.name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-ink-tertiary">Een overzicht van je taken en klantactiviteit.</p>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium text-ink-secondary">Taken</h2>
        <TaskSummaryWidget />
      </section>

      <section className="cc-card p-5">
        <h2 className="mb-2 text-sm font-medium text-ink-secondary">Snel starten</h2>
        <p className="text-sm text-ink-tertiary">
          Gebruik <kbd className="rounded border border-border bg-canvas px-1.5 py-0.5 text-[10px]">⌘K</kbd> om een
          klant te zoeken, of open het{" "}
          <Link href="/customers" className="text-accent-600 underline underline-offset-2">
            klantenoverzicht
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

import { getSessionUser } from "@/platform/auth/session";
import { TasksList } from "./TasksList";

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const user = await getSessionUser();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Taken</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Taken worden aangemaakt vanuit Customer 360. Hier beheer je je eigen en toegewezen taken.
        </p>
      </div>
      <TasksList initialTab={tab ?? "mine"} isAdmin={user?.role === "ADMIN"} />
    </div>
  );
}

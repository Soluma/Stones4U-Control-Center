import { redirect } from "next/navigation";
import { getSessionUser } from "@/platform/auth/session";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { countOpenTasksAssignedTo } from "@/modules/tasks/task.service";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // The Taken badge: one count query per render of this layout, never per nav item.
  const openTaskCount = await countOpenTasksAssignedTo(user.id).catch(() => 0);

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar openTaskCount={openTaskCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

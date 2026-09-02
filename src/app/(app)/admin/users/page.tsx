import { redirect } from "next/navigation";
import { getSessionUser } from "@/platform/auth/session";
import { UsersAdmin } from "./UsersAdmin";

export default async function AdminUsersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") {
    return (
      <div className="cc-card p-6 text-sm text-ink-secondary">
        Deze pagina is alleen beschikbaar voor beheerders.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Gebruikers</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Beheer Control Center-accounts en rollen.</p>
      </div>
      <UsersAdmin currentUserId={user.id} />
    </div>
  );
}

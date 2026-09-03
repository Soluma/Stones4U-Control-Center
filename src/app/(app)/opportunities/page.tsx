import { getSessionUser } from "@/platform/auth/session";
import { OpportunitiesBoard } from "./OpportunitiesBoard";

export default async function OpportunitiesPage() {
  const user = await getSessionUser();
  if (!user) return null; // (app)/layout already redirects unauthenticated users

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Verkoopkansen</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Volg lopende verkooptrajecten per klant — een klant kan meerdere gelijktijdige verkoopkansen hebben.
        </p>
      </div>
      <OpportunitiesBoard
        canCreate={user.role !== "VIEWER"}
        canEdit={user.role !== "VIEWER"}
        currentUserId={user.id}
        isAdmin={user.role === "ADMIN"}
      />
    </div>
  );
}

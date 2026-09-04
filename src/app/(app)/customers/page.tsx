import { CustomerSearch } from "./CustomerSearch";
import { CustomerListPanel } from "./CustomerListPanel";
import { getSessionUser } from "@/platform/auth/session";

// Phase 6b — default view is role-dependent (docs/platform-discovery/
// 46-PHASE-6B-MY-CUSTOMERS-DISCOVERY.md §9): AGENT defaults to "mine",
// ADMIN/VIEWER default to "all" (VIEWER is rarely an accountmanager
// themselves, so "mine" would usually be an empty, unhelpful landing
// view for that role). An explicit ?scope= always wins.
const VALID_SCOPES = ["mine", "unassigned", "all"] as const;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const user = await getSessionUser();
  if (!user) return null;
  const { scope } = await searchParams;

  const defaultScope = user.role === "AGENT" ? "mine" : "all";
  const initialScope = (VALID_SCOPES as readonly string[]).includes(scope ?? "") ? (scope as (typeof VALID_SCOPES)[number]) : defaultScope;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Klanten</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Zoek een klant in Shopify om Customer 360 te openen.</p>
      </div>
      <CustomerSearch />
      <CustomerListPanel initialScope={initialScope} canAssign={user.role !== "VIEWER"} />
    </div>
  );
}

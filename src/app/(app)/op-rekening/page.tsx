import { getSessionUser } from "@/platform/auth/session";
import { listOnAccountOrders } from "@/modules/on-account/on-account.service";
import { isOnAccountServiceEnabled } from "@/modules/on-account/config";
import { REVIEW_REASON_LABELS, type ReviewReason } from "@/modules/on-account/state-machine";
import { OnAccountClient, type OnAccountRowView } from "./OnAccountClient";

// Op rekening v1 — overview of every on-account order the central service
// tracks, with the v1 delivery trigger for bezorging ("Afgeleverd bij
// klant") and the explicit review decisions. Shopify stays the source of
// truth for the order; this shows the service's own progress.
export const dynamic = "force-dynamic";

export default async function OnAccountPage() {
  const user = await getSessionUser();
  const rows = await listOnAccountOrders();
  const view: OnAccountRowView[] = rows.map((r) => ({
    id: r.id,
    orderGid: r.shopifyOrderGid,
    orderName: r.orderName,
    sourceApp: r.sourceApp,
    termDays: r.termDays,
    state: r.state,
    reviewReason: r.reviewReason,
    reviewLabel: r.reviewReason ? (REVIEW_REASON_LABELS[r.reviewReason as ReviewReason] ?? r.reviewReason) : null,
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
    triggerSource: r.triggerSource,
    dueAt: r.dueAt?.toISOString() ?? null,
    invoiceSentAt: r.invoiceSentAt?.toISOString() ?? null,
    invoiceRecipient: r.invoiceRecipient,
    lastError: r.lastError,
    attempts: r.attempts,
    updatedAt: r.updatedAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Op rekening</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-tertiary">
          Orders op rekening krijgen pas een vervaldatum en betaallink op het moment van werkelijk afhalen of afleveren.
          Afhalen (Pick App) en &ldquo;direct meegegeven&rdquo; aan de kassa gaan automatisch; voor bezorging bevestig je
          hier &ldquo;Afgeleverd bij klant&rdquo;.
        </p>
        {!isOnAccountServiceEnabled() && (
          <p className="mt-2 rounded-md bg-warning-50 px-3 py-2 text-sm text-warning-700">
            De op-rekening-service staat in deze omgeving uit: er worden geen termijnen gezet en geen betaallinks verstuurd.
          </p>
        )}
      </div>
      <OnAccountClient rows={view} canWrite={user?.role === "ADMIN" || user?.role === "AGENT"} isAdmin={user?.role === "ADMIN"} />
    </div>
  );
}

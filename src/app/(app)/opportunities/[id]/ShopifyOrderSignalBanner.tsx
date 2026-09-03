"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";

// Phase 4B — BLUE commercial suggestion (build spec §18/§19). Never calls
// markWon() without an explicit human confirmation in this dialog; the
// suggested finalValue comes from the customer's own, already-fetched real
// Shopify order (never blindly overwritten — the field stays editable).
export function ShopifyOrderSignalBanner({
  opportunityId,
  orderName,
  orderAdminUrl,
  suggestedFinalValue,
  canEdit,
}: {
  opportunityId: string;
  orderName: string;
  orderAdminUrl: string;
  suggestedFinalValue: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [finalValue, setFinalValue] = useState(suggestedFinalValue ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    const response = await fetch(`/api/opportunities/${opportunityId}/won`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ finalValue: finalValue || undefined }),
    });
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? "Markeren als gewonnen mislukt.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="rounded-md border border-accent-500/30 bg-accent-50 p-3 text-sm">
      <div className="flex items-start gap-2">
        <PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-700" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-accent-700">Bestelling geplaatst</p>
          <p className="mt-0.5 text-xs text-ink-secondary">
            Order{" "}
            <a href={orderAdminUrl} target="_blank" rel="noreferrer noopener" className="underline">
              {orderName}
            </a>{" "}
            is aangemaakt vanuit de gekoppelde conceptbestelling.
          </p>
          {canEdit && (
            <Button variant="primary" size="sm" className="mt-2" onClick={() => setOpen(true)}>
              Markeer als gewonnen
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Verkoopkans gewonnen"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={submitting} onClick={handleConfirm}>
              Bevestigen
            </Button>
          </>
        }
      >
        {error && <p className="mb-2 text-xs text-danger-500">{error}</p>}
        <Input
          label="Definitieve waarde (€)"
          type="number"
          min={0}
          step="0.01"
          value={finalValue}
          onChange={(e) => setFinalValue(e.target.value)}
          hint={`Voorgesteld op basis van bestelling ${orderName} — pas aan indien nodig.`}
        />
      </Dialog>
    </div>
  );
}

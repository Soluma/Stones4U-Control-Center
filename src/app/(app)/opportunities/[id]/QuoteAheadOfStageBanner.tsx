"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { STAGE_LABEL } from "@/modules/opportunities/labels";

// Phase 4B — BLUE commercial suggestion (build spec §21). Purely
// informational — a single explicit human click calls the existing
// changeStage() via the existing route, never an automatic mutation.
export function QuoteAheadOfStageBanner({ opportunityId, canEdit }: { opportunityId: string; canEdit: boolean }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    const response = await fetch(`/api/opportunities/${opportunityId}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "QUOTE_SENT" }),
    });
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? "Fase wijzigen mislukt.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="rounded-md border border-accent-500/30 bg-accent-50 p-3 text-sm">
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-accent-700" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-accent-700">Offerte aanwezig</p>
          <p className="mt-0.5 text-xs text-ink-secondary">
            Er is een offerte aanwezig terwijl deze verkoopkans nog in een eerdere fase staat.
          </p>
          {error && <p className="mt-1 text-xs text-danger-500">{error}</p>}
          {canEdit && (
            <Button variant="secondary" size="sm" className="mt-2" loading={submitting} onClick={handleConfirm}>
              Fase wijzigen naar {STAGE_LABEL.QUOTE_SENT}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

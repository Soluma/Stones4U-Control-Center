"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { SkeletonList } from "@/components/ui/Skeleton";

// Phase 6L — staff classification of one Order's Stones4U fulfillment mode,
// opened from the Order row in the existing handoff workflow rather than
// living on a separate technical page (build instruction §2).
//
// The whole UI speaks Dutch business language. Canonical values
// (DELIVERY, CUSTOMER_PICKUP, …) are what gets stored and what the API
// exchanges, but they are never the primary thing staff read — the raw
// Shopify value is shown only as a small diagnostic line.

const MODE_LABELS: Record<string, string> = {
  DELIVERY: "Bezorgen",
  CUSTOMER_PICKUP: "Afhalen",
  PICKUP_POINT: "Afhaalpunt",
  RETAIL: "Winkelverkoop",
  NONE: "Geen fysieke levering",
  UNKNOWN: "Niet bepaald",
};

/** The order staff see these in matches how often each is used, not the
 * enum's declaration order. */
const SELECTABLE_MODES = ["DELIVERY", "CUSTOMER_PICKUP", "PICKUP_POINT", "RETAIL", "NONE"] as const;

type Resolution = {
  mode: string;
  source: "EXPLICIT" | "NATIVE" | "NONE";
  conflict: boolean;
  diagnostic: string;
};

type Classification = {
  orderGid: string;
  orderName: string;
  isCancelled: boolean;
  nativeFulfillmentMode: string;
  explicitFulfillmentMode: string | null;
  resolution: Resolution;
  requestedDeliveryDate: string | null;
};

type PendingConfirmation = {
  currentMode: string | null;
  currentState: "VALID" | "INVALID" | "DUPLICATE";
  requestedMode: string | null;
  /** Echoed back on the confirmed retry so the server can prove it applies
   * the transition that was actually shown here. */
  currentStateToken: string;
};

function label(mode: string | null): string {
  if (mode === null) return "Niet ingesteld";
  return MODE_LABELS[mode] ?? mode;
}

function resolvedTone(resolution: Resolution): "success" | "warning" | "neutral" {
  if (resolution.conflict) return "warning";
  if (resolution.mode === "UNKNOWN") return "neutral";
  return "success";
}

/** Staff-facing explanation of why the resolution came out the way it did.
 * Severity is deliberately graded: an explicit choice disagreeing with an
 * untrusted Shopify signal is normal during the migration and must not be
 * dressed up as an error, while a genuine contradiction is prominent. */
function diagnosticMessage(c: Classification): { tone: "info" | "warning"; text: string } | null {
  switch (c.resolution.diagnostic) {
    case "EXPLICIT_OVERRODE_NATIVE":
      return {
        tone: "info",
        text: `Shopify registreert deze order als ${label(c.nativeFulfillmentMode).toLowerCase()}, maar Stones4U heeft ${label(c.explicitFulfillmentMode).toLowerCase()} gekozen. Tijdens de overgang is dit normaal — de Stones4U-keuze geldt.`,
      };
    case "EXPLICIT_DELIVERY_CONTRADICTED":
      return {
        tone: "warning",
        text: "De Stones4U-keuze en de Shopify-afhandeling spreken elkaar tegen. Automatische leveringscommunicatie blijft geblokkeerd.",
      };
    case "DUPLICATE_EXPLICIT_KEY":
      return {
        tone: "warning",
        text: "Deze bestelling bevat meerdere Stones4U-keuzes en is daardoor niet te gebruiken. Kies hieronder één waarde om dit te herstellen.",
      };
    case "INVALID_EXPLICIT_VALUE":
      return {
        tone: "warning",
        text: "De opgeslagen Stones4U-keuze is niet herkend en is daardoor niet te gebruiken. Kies hieronder één waarde om dit te herstellen.",
      };
    case "NATIVE_NOT_TRUSTED":
      return {
        tone: "info",
        text: "Shopify meldt verzending, maar dat is bij Stones4U geen betrouwbaar bewijs van bezorging — afhaalorders worden vaak ook zo geregistreerd. Leg de keuze hieronder expliciet vast.",
      };
    default:
      return null;
  }
}

function Row({ children, value }: { children: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-ink-secondary">{children}</span>
      <span className="text-sm font-medium text-ink-primary">{value}</span>
    </div>
  );
}

export function FulfillmentModeDialog({
  orderGid,
  orderName,
  canWrite,
  open,
  onClose,
}: {
  orderGid: string | null;
  orderName: string | null;
  canWrite: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const [classification, setClassification] = useState<Classification | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  const load = useCallback(async () => {
    if (!orderGid) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/delivery-handoffs/order/fulfillment-mode?orderGid=${encodeURIComponent(orderGid)}`);
      if (!response.ok) throw new Error("Kon de afhandeling van deze bestelling niet ophalen.");
      setClassification((await response.json()) as Classification);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout.");
    } finally {
      setLoading(false);
    }
  }, [orderGid]);

  useEffect(() => {
    if (!open) {
      setClassification(null);
      setPending(null);
      setError(null);
      return;
    }
    void load();
  }, [open, load]);

  async function submit(mode: string | null, confirmChange: boolean, expectedCurrentState?: string) {
    if (!orderGid) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/delivery-handoffs/order/fulfillment-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderGid, mode, confirmChange: confirmChange || undefined, expectedCurrentState }),
      });
      const body = await response.json();

      // The server decides that a confirmation is needed, from state it read
      // itself — the client never assumes it from the value on screen.
      if (response.status === 409 && body?.code === "FULFILLMENT_MODE_CONFIRMATION_REQUIRED") {
        setPending({
          currentMode: body.currentMode,
          currentState: body.currentState,
          requestedMode: body.requestedMode,
          currentStateToken: body.currentStateToken,
        });
        return;
      }
      if (!response.ok) throw new Error(body?.error ?? "Opslaan is niet gelukt.");

      setPending(null);
      setClassification(body.classification as Classification);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout.");
    } finally {
      setSaving(false);
    }
  }

  const diagnostic = classification ? diagnosticMessage(classification) : null;
  const hasExplicitChoice =
    classification !== null &&
    (classification.explicitFulfillmentMode !== null ||
      classification.resolution.diagnostic === "DUPLICATE_EXPLICIT_KEY" ||
      classification.resolution.diagnostic === "INVALID_EXPLICIT_VALUE");

  // A pending confirmation replaces the normal body — staff answer one
  // question at a time (build instruction §10).
  if (pending) {
    return (
      <Dialog
        open={open}
        onClose={() => setPending(null)}
        title={pending.requestedMode === null ? "Handmatige keuze verwijderen?" : "Afhandeling wijzigen?"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void submit(pending.requestedMode, true, pending.currentStateToken)}>
              Wijziging bevestigen
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Row value={pending.currentState === "VALID" ? label(pending.currentMode) : "Ongeldig of dubbel vastgelegd"}>
            Huidige keuze
          </Row>
          <Row value={pending.requestedMode === null ? "Geen handmatige keuze" : label(pending.requestedMode)}>
            Nieuwe keuze
          </Row>
          <p className="text-sm text-ink-secondary">
            Deze wijziging kan later invloed hebben op de automatische leveringscommunicatie.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Afhandeling ${orderName ?? ""}`.trim()}
      description="Leg vast hoe Stones4U deze bestelling levert. Dit verandert niets aan de facturatie van Shopify."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Sluiten
        </Button>
      }
    >
      {loading && <SkeletonList rows={3} />}
      {error && <p className="text-sm text-danger-500">{error}</p>}

      {classification && !loading && (
        <div className="space-y-4">
          <div>
            <Row value={<span className="text-ink-secondary">{label(classification.nativeFulfillmentMode)}</span>}>
              Shopify-signaal
            </Row>
            <Row value={label(classification.explicitFulfillmentMode)}>Stones4U-keuze</Row>
            <Row
              value={
                <Badge tone={resolvedTone(classification.resolution)}>{label(classification.resolution.mode)}</Badge>
              }
            >
              Effectieve classificatie
            </Row>
            {classification.requestedDeliveryDate && (
              <Row value={<span className="text-ink-secondary">{classification.requestedDeliveryDate}</span>}>
                Gewenste leverdatum
              </Row>
            )}
          </div>

          {diagnostic && (
            <p
              className={
                diagnostic.tone === "warning"
                  ? "rounded-md border border-warning-500/20 bg-warning-50 px-3 py-2 text-sm text-warning-700"
                  : "text-sm text-ink-secondary"
              }
            >
              {diagnostic.text}
            </p>
          )}

          {classification.isCancelled ? (
            <p className="text-sm text-ink-tertiary">
              Deze bestelling is geannuleerd — de afhandeling is niet meer te wijzigen.
            </p>
          ) : canWrite ? (
            <div className="space-y-2">
              <p className="text-sm text-ink-secondary">Stones4U-keuze vastleggen</p>
              <div className="flex flex-wrap gap-2">
                {SELECTABLE_MODES.map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    variant={classification.explicitFulfillmentMode === mode ? "primary" : "secondary"}
                    disabled={saving}
                    onClick={() => void submit(mode, false)}
                  >
                    {MODE_LABELS[mode]}
                  </Button>
                ))}
              </div>
              {hasExplicitChoice && (
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => void submit(null, false)}>
                  Handmatige keuze verwijderen
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-tertiary">U heeft geen rechten om de afhandeling te wijzigen.</p>
          )}

          <p className="text-xs text-ink-tertiary">
            {`Shopify: ${classification.nativeFulfillmentMode}. `}
            {"Automatische leveringscommunicatie is nog niet actief; deze keuze legt alleen de classificatie vast."}
          </p>
        </div>
      )}
    </Dialog>
  );
}

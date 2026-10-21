"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";

export type OnAccountRowView = {
  id: string;
  orderGid: string;
  orderName: string | null;
  sourceApp: string;
  termDays: number | null;
  state: string;
  reviewReason: string | null;
  reviewLabel: string | null;
  deliveredAt: string | null;
  triggerSource: string | null;
  dueAt: string | null;
  invoiceSentAt: string | null;
  invoiceRecipient: string | null;
  invoiceNumber: string | null;
  invoiceMailSuppressed: string | null;
  lastError: string | null;
  attempts: number;
  updatedAt: string;
};

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const STATE_LABELS: Record<string, { label: string; tone: Tone }> = {
  REGISTERED: { label: "Geregistreerd", tone: "neutral" },
  PENDING_TEMP_TERMS: { label: "Opschonen tijdelijke termijn", tone: "warning" },
  WAITING_FOR_DELIVERY: { label: "Wacht op levering", tone: "neutral" },
  DELIVERED: { label: "Geleverd — termijn zetten", tone: "accent" },
  TERMS_SET: { label: "Termijn gezet — factuur volgt", tone: "accent" },
  INVOICE_GENERATING: { label: "Factuur wordt gemaakt", tone: "accent" },
  INVOICE_READY: { label: "Factuur klaar — mail volgt", tone: "accent" },
  INVOICE_SENDING: { label: "Factuurmail wordt verstuurd", tone: "accent" },
  INVOICE_SENT: { label: "Factuur verstuurd", tone: "success" },
  PAID: { label: "Betaald", tone: "success" },
  CANCELLED: { label: "Geannuleerd", tone: "neutral" },
  MANUAL_REVIEW: { label: "Handmatige controle", tone: "danger" },
};

const TRIGGER_LABELS: Record<string, string> = {
  COUNTER_HANDOVER: "kassa: direct meegegeven",
  PICKUP_HANDOVER: "afgehaald (Pick App)",
  MANUAL_DELIVERY: "afgeleverd (handmatig)",
  MANUAL_INVOICE: "betaallink handmatig",
};

const FILTERS = [
  {
    key: "open",
    label: "Openstaand",
    states: ["REGISTERED", "PENDING_TEMP_TERMS", "WAITING_FOR_DELIVERY", "DELIVERED", "TERMS_SET", "INVOICE_SENDING", "INVOICE_SENT"],
  },
  { key: "review", label: "Controle nodig", states: ["MANUAL_REVIEW"] },
  { key: "done", label: "Afgerond", states: ["PAID", "CANCELLED"] },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function fmt(iso: string | null, withTime = false): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(iso));
}

/** "YYYY-MM-DDTHH:mm" in the browser's local time, for datetime-local. */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function OnAccountClient({ rows, canWrite, isAdmin }: { rows: OnAccountRowView[]; canWrite: boolean; isAdmin: boolean }) {
  const [filter, setFilter] = useState<FilterKey>("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deliveryFor, setDeliveryFor] = useState<OnAccountRowView | null>(null);
  const [deliveredAt, setDeliveredAt] = useState(localNow());
  const [confirmed, setConfirmed] = useState(false);
  const router = useRouter();

  const visible = useMemo(() => {
    const states: readonly string[] = FILTERS.find((f) => f.key === filter)?.states ?? [];
    return rows.filter((r) => states.includes(r.state));
  }, [rows, filter]);

  async function post(id: string, path: string, body: unknown): Promise<boolean> {
    setBusy(id);
    setMessage(null);
    const r = await fetch(`/api/on-account/${id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    setBusy(null);
    if (!r.ok) setMessage(data?.error ?? `Actie niet uitgevoerd (${data?.outcome ?? r.status}).`);
    else setMessage(data?.outcome ? `Resultaat: ${data.outcome}` : "Bijgewerkt.");
    router.refresh();
    return r.ok;
  }

  async function submitDelivery() {
    if (!deliveryFor || !confirmed) return;
    const ok = await post(deliveryFor.id, "delivered", { deliveredAt: new Date(deliveredAt).toISOString(), confirmed: true });
    if (ok) {
      setDeliveryFor(null);
      setConfirmed(false);
    }
  }

  async function resolve(row: OnAccountRowView, resolution: string, question: string) {
    const note = window.prompt(`${question}\n\nKorte toelichting (verplicht, komt in het auditlog):`);
    if (!note || note.trim().length < 3) return;
    await post(row.id, "review", { resolution, note });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-md border px-3 py-1 text-sm cc-focus-ring ${filter === f.key ? "border-accent-500 bg-accent-50 text-accent-700" : "border-border text-ink-secondary"}`}
          >
            {f.label} ({rows.filter((r) => (f.states as readonly string[]).includes(r.state)).length})
          </button>
        ))}
      </div>
      {message && <p className="rounded-md border border-border px-3 py-2 text-sm text-ink-secondary">{message}</p>}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-ink-tertiary">
            <tr>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Termijn</th>
              <th className="px-3 py-2">Geleverd</th>
              <th className="px-3 py-2">Vervaldatum</th>
              <th className="px-3 py-2">Factuur</th>
              <th className="px-3 py-2">Acties</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-ink-tertiary">
                  Geen orders in deze lijst.
                </td>
              </tr>
            )}
            {visible.map((r) => {
              const state = STATE_LABELS[r.state] ?? { label: r.state, tone: "neutral" as Tone };
              return (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink-primary">{r.orderName ?? r.orderGid.split("/").pop()}</div>
                    <div className="text-xs text-ink-tertiary">
                      {r.sourceApp === "SOURCE2POS" ? "Kassa" : r.sourceApp === "OFFERTEAPP" ? "OfferteApp" : "onbekend"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={state.tone}>{state.label}</Badge>
                    {r.reviewLabel && <div className="mt-1 text-xs text-danger-700">{r.reviewLabel}</div>}
                    {r.lastError && r.state !== "MANUAL_REVIEW" && (
                      <div className="mt-1 text-xs text-ink-tertiary">
                        poging {r.attempts}: {r.lastError}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">{r.termDays ? `${r.termDays} dagen` : "—"}</td>
                  <td className="px-3 py-2">
                    {fmt(r.deliveredAt, true)}
                    {r.triggerSource && <div className="text-xs text-ink-tertiary">{TRIGGER_LABELS[r.triggerSource] ?? r.triggerSource}</div>}
                  </td>
                  <td className="px-3 py-2">{fmt(r.dueAt)}</td>
                  <td className="px-3 py-2">
                    {r.invoiceNumber && (
                      <a href={`/api/on-account/${r.id}/invoice`} className="block text-xs font-medium text-accent-700 underline cc-focus-ring">
                        Factuur {r.invoiceNumber} (PDF)
                      </a>
                    )}
                    {fmt(r.invoiceSentAt, true)}
                    {r.invoiceRecipient && <div className="text-xs text-ink-tertiary">{r.invoiceRecipient}</div>}
                    {r.invoiceMailSuppressed && (
                      <div className="text-xs text-ink-tertiary">
                        geen mail: {r.invoiceMailSuppressed === "PAID_BEFORE_SEND" ? "al betaald" : r.invoiceMailSuppressed === "CANCELLED_BEFORE_SEND" ? "geannuleerd" : r.invoiceMailSuppressed}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      {canWrite && r.state === "WAITING_FOR_DELIVERY" && (
                        <button
                          type="button"
                          disabled={busy === r.id}
                          onClick={() => {
                            setDeliveryFor(r);
                            setDeliveredAt(localNow());
                            setConfirmed(false);
                          }}
                          className="rounded-md border border-border px-2 py-0.5 text-xs font-medium cc-focus-ring"
                        >
                          Afgeleverd bij klant
                        </button>
                      )}
                      {canWrite && ["REGISTERED", "PENDING_TEMP_TERMS", "DELIVERED", "TERMS_SET"].includes(r.state) && (
                        <button type="button" disabled={busy === r.id} onClick={() => post(r.id, "retry", {})} className="text-xs text-accent-700 cc-focus-ring">
                          Nu opnieuw proberen
                        </button>
                      )}
                      {isAdmin && r.state === "MANUAL_REVIEW" && r.reviewReason === "INVOICE_SEND_UNCERTAIN" && (
                        <>
                          <button
                            type="button"
                            onClick={() => resolve(r, "MARK_INVOICE_SENT", "Gecontroleerd (mailbox/klant): de factuurmail IS verstuurd?")}
                            className="text-xs text-accent-700 cc-focus-ring"
                          >
                            Is verstuurd (vastleggen)
                          </button>
                          <button
                            type="button"
                            onClick={() => resolve(r, "RETRY_INVOICE", "Gecontroleerd: de factuurmail is NIET verstuurd? Er gaat precies één nieuwe mail uit met dezelfde factuur.")}
                            className="text-xs text-accent-700 cc-focus-ring"
                          >
                            Niet verstuurd — opnieuw versturen
                          </button>
                        </>
                      )}
                      {isAdmin && r.state === "MANUAL_REVIEW" && r.reviewReason !== "INVOICE_SEND_UNCERTAIN" && (
                        <button
                          type="button"
                          onClick={() => resolve(r, "RETRY_FROM_START", "Het probleem is in Shopify opgelost — opnieuw verwerken?")}
                          className="text-xs text-accent-700 cc-focus-ring"
                        >
                          Opgelost — opnieuw verwerken
                        </button>
                      )}
                      {isAdmin && r.state === "MANUAL_REVIEW" && (
                        <button
                          type="button"
                          onClick={() => resolve(r, "MARK_CANCELLED", "Deze order niet meer via op rekening volgen?")}
                          className="text-xs text-ink-tertiary cc-focus-ring"
                        >
                          Niet meer volgen
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {deliveryFor && (
        <div role="dialog" aria-modal="true" aria-labelledby="delivery-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface p-5 shadow-lg">
            <h2 id="delivery-title" className="text-base font-semibold text-ink-primary">
              Afgeleverd bij klant — {deliveryFor.orderName}
            </h2>
            <p className="text-sm text-ink-secondary">
              De betaaltermijn van {deliveryFor.termDays ?? "?"} dagen start op dit moment. Daarna zet het systeem de
              vervaldatum in Shopify, maakt het de factuur en stuurt het één factuurmail met betaalknop naar de klant.
            </p>
            <label className="block text-sm">
              <span className="text-ink-tertiary">Moment van aflevering</span>
              <input
                type="datetime-local"
                value={deliveredAt}
                max={localNow()}
                onChange={(e) => setDeliveredAt(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1 cc-focus-ring"
              />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
              <span>Ik bevestig dat de goederen volledig bij de klant zijn afgeleverd.</span>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeliveryFor(null)} className="rounded-md border border-border px-3 py-1 text-sm cc-focus-ring">
                Annuleren
              </button>
              <button
                type="button"
                disabled={!confirmed || busy === deliveryFor.id}
                onClick={submitDelivery}
                className="rounded-md border border-accent-500 bg-accent-50 px-3 py-1 text-sm font-medium text-accent-700 cc-focus-ring disabled:opacity-50"
              >
                {busy === deliveryFor.id ? "Bezig…" : "Bevestigen"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

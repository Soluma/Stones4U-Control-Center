"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, CalendarClock } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { SkeletonList } from "@/components/ui/Skeleton";
import { formatDate, formatDateLong, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";

// Phase 6E — this staff page now creates handoffs for two different kinds
// of Shopify commerce object (see docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md
// §"Staff Order handoff management"). The tab strip below controls only
// which search+create UI is shown ("Orders" is the default — real Orders
// are the normal, present-day case; "Draft Orders" retains the original
// Phase 5A flow byte-for-byte, same endpoint, same request shape, same
// dialog copy). The management table further down is always unified
// (build instruction §14) — one list, an optional type filter, never two
// separate tables — because staff need to see both kinds of link
// side by side.

type DraftOrderSearchResult = {
  gid: string;
  legacyResourceId: string;
  name: string;
  status: string;
  customerGid: string | null;
  customerName: string | null;
};

type OrderSearchResult = {
  gid: string;
  name: string;
  createdAt: string;
  isCancelled: boolean;
  fulfillmentStatus: string;
  customerGid: string | null;
  hasShippingAddress: boolean;
  // The actual value when Shopify already has one — provenance-neutral by
  // design (build instruction §2/§12): it may have come from an earlier
  // quote, the Draft stage, staff, or the customer portal, and this field
  // alone never tells you which. Never render this as if the customer
  // portal were the confirmed origin.
  requestedDeliveryDate: string | null;
  hasExistingHandoff: boolean;
};

type Handoff = {
  id: string;
  commerceObjectType: "SHOPIFY_DRAFT_ORDER" | "SHOPIFY_ORDER";
  shopifyDraftOrderGid: string | null;
  shopifyOrderGid: string | null;
  publicReference: string | null;
  requestedDeliveryDate: string | null;
  status: "PENDING" | "MIRRORED" | "ERROR";
  createdAt: string;
  updatedAt: string;
  customerProfile: { id: string; displayName: string | null; companyName: string | null } | null;
};

const STATUS_LABEL: Record<Handoff["status"], string> = {
  PENDING: "In afwachting",
  MIRRORED: "Doorgegeven aan Shopify",
  ERROR: "Doorgeven mislukt",
};
const STATUS_TONE: Record<Handoff["status"], "success" | "warning" | "neutral" | "danger"> = {
  PENDING: "neutral",
  MIRRORED: "success",
  ERROR: "danger",
};

/** Bare numeric id from a Shopify GID — display only, matches the pattern
 * already used server-side (e.g. src/integrations/shopify/draft-orders.ts).
 * Only ever used as a Draft Order's reference — historical Draft rows have
 * no publicReference (schema.prisma: "populated only for commerceObjectType
 * = SHOPIFY_ORDER... never backfilled" for Draft rows), so this remains the
 * only display Draft handoffs have ever had, unchanged this phase. */
function legacyIdFromGid(gid: string | null): string {
  if (!gid) return "—";
  return /\/(\d+)$/.exec(gid)?.[1] ?? gid;
}

/** Order rows always carry a real publicReference captured at creation
 * time (Shopify's own order name, e.g. "#1025") — the numeric fallback
 * only guards a theoretical row with the field somehow unset. */
function referenceForHandoff(handoff: Handoff): string {
  if (handoff.commerceObjectType === "SHOPIFY_ORDER") {
    return handoff.publicReference ?? `#${legacyIdFromGid(handoff.shopifyOrderGid)}`;
  }
  return `#${legacyIdFromGid(handoff.shopifyDraftOrderGid)}`;
}

const TYPE_LABEL: Record<Handoff["commerceObjectType"], string> = {
  SHOPIFY_ORDER: "Order",
  SHOPIFY_DRAFT_ORDER: "Draft Order",
};

type ListFilter = "all" | "order" | "draft";

function FilterToggle({ value, onChange }: { value: ListFilter; onChange: (v: ListFilter) => void }) {
  const options: { key: ListFilter; label: string }[] = [
    { key: "all", label: "Alle" },
    { key: "order", label: "Orders" },
    { key: "draft", label: "Draft Orders" },
  ];
  return (
    <div className="flex gap-1 rounded-md border border-border p-0.5">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={cn(
            "cc-focus-ring rounded px-2.5 py-1 text-xs font-medium transition-colors",
            value === opt.key ? "bg-accent-50 text-accent-700" : "text-ink-tertiary hover:text-ink-primary",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function DeliveryHandoffsClient({ canCreate }: { canCreate: boolean }) {
  const [tab, setTab] = useState<"order" | "draft">("order");
  const [listFilter, setListFilter] = useState<ListFilter>("all");

  const [term, setTerm] = useState("");
  const [draftResults, setDraftResults] = useState<DraftOrderSearchResult[]>([]);
  const [orderResults, setOrderResults] = useState<OrderSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [creatingGid, setCreatingGid] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loadingHandoffs, setLoadingHandoffs] = useState(true);

  const [linkDialog, setLinkDialog] = useState<{ url: string | null; alreadyExisted: boolean } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ result: OrderSearchResult; requestedDeliveryDate: string } | null>(null);

  const loadHandoffs = useCallback(async () => {
    setLoadingHandoffs(true);
    const res = await fetch("/api/delivery-handoffs");
    const body = await res.json().catch(() => ({ handoffs: [] }));
    setHandoffs(body.handoffs ?? []);
    setLoadingHandoffs(false);
  }, []);

  useEffect(() => {
    void loadHandoffs();
  }, [loadHandoffs]);

  // Reset the search box and results when switching tabs — a Draft Order
  // GID and an Order GID are never interchangeable, so stale results from
  // the other tab must never linger into a create action.
  useEffect(() => {
    setTerm("");
    setDraftResults([]);
    setOrderResults([]);
    setSearchError(null);
  }, [tab]);

  useEffect(() => {
    if (term.trim().length < 2) {
      setDraftResults([]);
      setOrderResults([]);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const controller = new AbortController();
    const endpoint = tab === "order" ? "/api/delivery-handoffs/order-search" : "/api/delivery-handoffs/draft-order-search";
    const timeout = setTimeout(() => {
      fetch(`${endpoint}?q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body.error ?? "Zoeken mislukt.");
          }
          return r.json();
        })
        .then((body) => {
          if (tab === "order") setOrderResults(body.results ?? []);
          else setDraftResults(body.results ?? []);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") return;
          setSearchError(error instanceof Error ? error.message : "Zoeken mislukt.");
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [term, tab]);

  async function handleCreateDraft(result: DraftOrderSearchResult) {
    setCreatingGid(result.gid);
    try {
      const res = await fetch("/api/delivery-handoffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopifyDraftOrderGid: result.gid, shopifyCustomerGid: result.customerGid ?? undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setSearchError(body.error ?? "Aanmaken mislukt.");
        return;
      }
      setLinkDialog({ url: body.publicUrl, alreadyExisted: body.alreadyExisted });
      await loadHandoffs();
    } finally {
      setCreatingGid(null);
    }
  }

  async function handleCreateOrder(result: OrderSearchResult, confirmExisting = false) {
    setCreatingGid(result.gid);
    try {
      // The client identifies which Order was selected, by GID, plus —
      // only when staff has explicitly confirmed past the warning below —
      // a narrow boolean intent flag. publicReference/customerProfileId/
      // commerceObjectType are all re-derived server-side from a fresh
      // Shopify read (build instruction §6), never sent here.
      const res = await fetch("/api/delivery-handoffs/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderGid: result.gid,
          ...(confirmExisting ? { confirmExistingRequestedDeliveryDate: true } : {}),
        }),
      });
      const body = await res.json();

      if (res.status === 409 && body.code === "EXISTING_REQUESTED_DELIVERY_DATE") {
        setConfirmDialog({ result, requestedDeliveryDate: body.requestedDeliveryDate });
        return;
      }
      if (!res.ok) {
        setSearchError(body.error ?? "Aanmaken mislukt.");
        return;
      }
      setLinkDialog({ url: body.publicUrl, alreadyExisted: body.alreadyExisted });
      await loadHandoffs();
    } finally {
      setCreatingGid(null);
    }
  }

  async function handleRegenerate(handoffId: string) {
    setRegeneratingId(handoffId);
    try {
      const res = await fetch(`/api/delivery-handoffs/${handoffId}/regenerate-token`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setSearchError(body.error ?? "Vernieuwen mislukt.");
        return;
      }
      setLinkDialog({ url: body.publicUrl, alreadyExisted: false });
      await loadHandoffs();
    } finally {
      setRegeneratingId(null);
    }
  }

  const visibleHandoffs = handoffs.filter((h) => {
    if (listFilter === "all") return true;
    if (listFilter === "order") return h.commerceObjectType === "SHOPIFY_ORDER";
    return h.commerceObjectType === "SHOPIFY_DRAFT_ORDER";
  });

  return (
    <div className="space-y-8">
      {canCreate && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-ink-secondary">Nieuwe link aanmaken</h2>
          <Tabs
            items={[
              { key: "order", label: "Orders" },
              { key: "draft", label: "Draft Orders" },
            ]}
            active={tab}
            onSelect={(key) => setTab(key as "order" | "draft")}
          />

          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" aria-hidden />
            <Input
              className="pl-9"
              placeholder={tab === "order" ? "Zoek op bestelnummer…" : "Zoek op conceptbestelling­nummer…"}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </div>
          {searchError && <p className="text-sm text-danger-500">{searchError}</p>}
          {searching && <SkeletonList rows={2} />}

          {!searching && tab === "order" && orderResults.length > 0 && (
            <Table>
              <TableHead>
                <TableHeaderCell>Order</TableHeaderCell>
                <TableHeaderCell>Datum</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Leverdatumvoorkeur</TableHeaderCell>
                <TableHeaderCell>Handoff</TableHeaderCell>
                <TableHeaderCell className="w-48">
                  <span className="sr-only">Acties</span>
                </TableHeaderCell>
              </TableHead>
              <TableBody>
                {orderResults.map((result) => (
                  <TableRow key={result.gid}>
                    <TableCell className="font-medium text-ink-primary">{result.name}</TableCell>
                    <TableCell className="text-ink-secondary">{formatDate(result.createdAt)}</TableCell>
                    <TableCell>
                      <Badge tone={result.isCancelled ? "danger" : "success"}>
                        {result.isCancelled ? "Geannuleerd" : "Actief"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-ink-secondary">
                      {result.requestedDeliveryDate ? (
                        <span>Reeds bekend: {formatDateLong(result.requestedDeliveryDate)}</span>
                      ) : (
                        "Nog niet bekend"
                      )}
                    </TableCell>
                    <TableCell className="text-ink-secondary">
                      {result.hasExistingHandoff ? "Aanwezig" : "Niet aanwezig"}
                    </TableCell>
                    <TableCell>
                      {result.isCancelled ? (
                        <span className="text-xs text-ink-tertiary">Geannuleerd — geen nieuwe link</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={creatingGid === result.gid}
                          onClick={() => handleCreateOrder(result)}
                        >
                          Leverdatumlink aanmaken
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!searching && tab === "draft" && draftResults.length > 0 && (
            <Table>
              <TableHead>
                <TableHeaderCell>Concept</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Klant</TableHeaderCell>
                <TableHeaderCell className="w-44">
                  <span className="sr-only">Acties</span>
                </TableHeaderCell>
              </TableHead>
              <TableBody>
                {draftResults.map((result) => (
                  <TableRow key={result.gid}>
                    <TableCell className="font-medium text-ink-primary">{result.name}</TableCell>
                    <TableCell className="text-ink-secondary">{result.status}</TableCell>
                    <TableCell className="text-ink-secondary">{result.customerName ?? "—"}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={creatingGid === result.gid}
                        onClick={() => handleCreateDraft(result)}
                      >
                        Leverdatumlink aanmaken
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium text-ink-secondary">Bestaande links</h2>
          <FilterToggle value={listFilter} onChange={setListFilter} />
        </div>
        {loadingHandoffs && <SkeletonList rows={3} />}
        {!loadingHandoffs && visibleHandoffs.length === 0 && (
          <EmptyState
            icon={<CalendarClock className="h-5 w-5" />}
            title="Nog geen leverdatum-links"
            description="Zoek hierboven een Order of conceptbestelling om de eerste link aan te maken."
          />
        )}
        {!loadingHandoffs && visibleHandoffs.length > 0 && (
          <Table>
            <TableHead>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Referentie</TableHeaderCell>
              <TableHeaderCell>Klant</TableHeaderCell>
              <TableHeaderCell>Gewenste leverdatum</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Bijgewerkt</TableHeaderCell>
              {canCreate && (
                <TableHeaderCell className="w-32">
                  <span className="sr-only">Acties</span>
                </TableHeaderCell>
              )}
            </TableHead>
            <TableBody>
              {visibleHandoffs.map((handoff) => (
                <TableRow key={handoff.id}>
                  <TableCell>
                    <Badge tone={handoff.commerceObjectType === "SHOPIFY_ORDER" ? "accent" : "neutral"}>
                      {TYPE_LABEL[handoff.commerceObjectType]}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium text-ink-primary">{referenceForHandoff(handoff)}</TableCell>
                  <TableCell className="text-ink-secondary">
                    {handoff.customerProfile?.displayName ?? handoff.customerProfile?.companyName ?? "—"}
                  </TableCell>
                  <TableCell className="text-ink-secondary">
                    {handoff.requestedDeliveryDate ? handoff.requestedDeliveryDate.slice(0, 10) : "Nog niet gekozen"}
                  </TableCell>
                  <TableCell>
                    <Badge tone={STATUS_TONE[handoff.status]}>{STATUS_LABEL[handoff.status]}</Badge>
                  </TableCell>
                  <TableCell className="text-ink-secondary">{formatDateTime(handoff.updatedAt)}</TableCell>
                  {canCreate && (
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={regeneratingId === handoff.id}
                        onClick={() => handleRegenerate(handoff.id)}
                      >
                        Vernieuw link
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog
        open={linkDialog !== null}
        onClose={() => setLinkDialog(null)}
        title={linkDialog?.alreadyExisted ? "Er bestaat al een link" : "Leverdatumlink aangemaakt"}
        description={
          linkDialog?.alreadyExisted
            ? "Hiervoor bestaat al een link. De oorspronkelijke link is niet opnieuw op te vragen — gebruik 'Vernieuw link' hieronder als die kwijt is."
            : "Kopieer deze link nu — hij is hierna niet meer op te vragen."
        }
        footer={
          <Button variant="secondary" onClick={() => setLinkDialog(null)}>
            Sluiten
          </Button>
        }
      >
        {linkDialog?.url && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-canvas px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-xs text-ink-secondary">{linkDialog.url}</code>
            <CopyButton value={linkDialog.url} label="Link kopiëren" />
          </div>
        )}
      </Dialog>

      <Dialog
        open={confirmDialog !== null}
        onClose={() => setConfirmDialog(null)}
        title="Gewenste leverdatum al bekend"
        description={
          confirmDialog
            ? `Voor deze bestelling is al een gewenste leverdatum van ${formatDateLong(confirmDialog.requestedDeliveryDate)} geregistreerd. Wilt u de klant opnieuw vragen een gewenste leverdatum door te geven?`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDialog(null)}>
              Annuleren
            </Button>
            <Button
              variant="primary"
              loading={confirmDialog ? creatingGid === confirmDialog.result.gid : false}
              onClick={() => {
                if (!confirmDialog) return;
                const { result } = confirmDialog;
                setConfirmDialog(null);
                void handleCreateOrder(result, true);
              }}
            >
              Toch nieuwe link maken
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}

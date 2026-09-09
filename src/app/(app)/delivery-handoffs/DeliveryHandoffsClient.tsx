"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, CalendarClock } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { SkeletonList } from "@/components/ui/Skeleton";
import { formatDateTime } from "@/lib/format";

type DraftOrderSearchResult = {
  gid: string;
  legacyResourceId: string;
  name: string;
  status: string;
  customerGid: string | null;
  customerName: string | null;
};

type Handoff = {
  id: string;
  shopifyDraftOrderGid: string | null;
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
 * already used server-side (e.g. src/integrations/shopify/draft-orders.ts). */
function legacyIdFromGid(gid: string | null): string {
  if (!gid) return "—";
  return /\/(\d+)$/.exec(gid)?.[1] ?? gid;
}

export function DeliveryHandoffsClient({ canCreate }: { canCreate: boolean }) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<DraftOrderSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [creatingGid, setCreatingGid] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loadingHandoffs, setLoadingHandoffs] = useState(true);

  const [linkDialog, setLinkDialog] = useState<{ url: string | null; alreadyExisted: boolean } | null>(null);

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

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      fetch(`/api/delivery-handoffs/draft-order-search?q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body.error ?? "Zoeken mislukt.");
          }
          return r.json();
        })
        .then((body) => setResults(body.results ?? []))
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
  }, [term]);

  async function handleCreate(result: DraftOrderSearchResult) {
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

  return (
    <div className="space-y-8">
      {canCreate && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-ink-secondary">Nieuwe link aanmaken</h2>
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" aria-hidden />
            <Input
              className="pl-9"
              placeholder="Zoek op conceptbestelling­nummer…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </div>
          {searchError && <p className="text-sm text-danger-500">{searchError}</p>}
          {searching && <SkeletonList rows={2} />}
          {!searching && results.length > 0 && (
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
                {results.map((result) => (
                  <TableRow key={result.gid}>
                    <TableCell className="font-medium text-ink-primary">{result.name}</TableCell>
                    <TableCell className="text-ink-secondary">{result.status}</TableCell>
                    <TableCell className="text-ink-secondary">{result.customerName ?? "—"}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={creatingGid === result.gid}
                        onClick={() => handleCreate(result)}
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
        <h2 className="text-sm font-medium text-ink-secondary">Bestaande links</h2>
        {loadingHandoffs && <SkeletonList rows={3} />}
        {!loadingHandoffs && handoffs.length === 0 && (
          <EmptyState
            icon={<CalendarClock className="h-5 w-5" />}
            title="Nog geen leverdatum-links"
            description="Zoek hierboven een conceptbestelling om de eerste link aan te maken."
          />
        )}
        {!loadingHandoffs && handoffs.length > 0 && (
          <Table>
            <TableHead>
              <TableHeaderCell>Concept</TableHeaderCell>
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
              {handoffs.map((handoff) => (
                <TableRow key={handoff.id}>
                  <TableCell className="font-medium text-ink-primary">#{legacyIdFromGid(handoff.shopifyDraftOrderGid)}</TableCell>
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
            ? "Deze conceptbestelling had al een link. De oorspronkelijke link is niet opnieuw op te vragen — gebruik 'Vernieuw link' hieronder als die kwijt is."
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
    </div>
  );
}

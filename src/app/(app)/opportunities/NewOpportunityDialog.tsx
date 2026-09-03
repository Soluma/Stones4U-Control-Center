"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

type CustomerSearchResult = {
  shopify: { gid: string; displayName: string; company: string | null; email: string | null };
  customerProfileId: string | null;
};

type AssignableUser = { id: string; name: string };

type SelectedCustomer = { customerProfileId: string; name: string };

/** Reused from both /opportunities (no customer known yet — searches
 * Shopify + resolves a CustomerProfile, same two-step flow as
 * CustomerSearch.tsx) and Customer 360's Commercieel tab (customer already
 * known — the search step is skipped entirely). Always creates through the
 * customer-scoped POST /api/customers/[id]/opportunities endpoint, so both
 * call sites share one creation path. */
export function NewOpportunityDialog({
  open,
  onClose,
  onCreated,
  fixedCustomer,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  fixedCustomer?: SelectedCustomer;
}) {
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerSearchResult[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(fixedCustomer ?? null);
  const [resolving, setResolving] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [probability, setProbability] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedCustomer(fixedCustomer ?? null);
    setCustomerQuery("");
    setCustomerResults([]);
    setTitle("");
    setDescription("");
    setEstimatedValue("");
    setProbability("");
    setExpectedCloseDate("");
    setOwnerUserId("");
    setError(null);
    fetch("/api/users/assignable")
      .then((r) => r.json())
      .then((data) => setUsers(data.users ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (fixedCustomer || customerQuery.trim().length < 2) {
      setCustomerResults([]);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      fetch(`/api/customers/search?q=${encodeURIComponent(customerQuery)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => setCustomerResults(data.results ?? []))
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [customerQuery, fixedCustomer]);

  async function pickCustomer(result: CustomerSearchResult) {
    setResolving(true);
    const response = await fetch("/api/customers/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopifyGid: result.shopify.gid }),
    });
    const data = await response.json();
    setResolving(false);
    if (data.customerProfileId) {
      setSelectedCustomer({ customerProfileId: data.customerProfileId, name: result.shopify.displayName });
    }
  }

  async function handleCreate() {
    if (!selectedCustomer || title.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    const response = await fetch(`/api/customers/${selectedCustomer.customerProfileId}/opportunities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: description || undefined,
        estimatedValue: estimatedValue || undefined,
        probability: probability ? Number(probability) : undefined,
        expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate).toISOString() : undefined,
        ownerUserId: ownerUserId || undefined,
      }),
    });
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? "Aanmaken mislukt.");
      return;
    }
    onClose();
    onCreated();
  }

  const canSubmit = !!selectedCustomer && title.trim().length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nieuwe verkoopkans"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={handleCreate}>
            Aanmaken
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <p className="text-xs text-danger-500">{error}</p>}

        {!fixedCustomer && !selectedCustomer && (
          <div className="space-y-2">
            <label className="cc-label">Klant</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" aria-hidden />
              <input
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="Zoek klant op naam, e-mail of telefoon…"
                className="cc-input py-1.5 pl-8 text-sm"
                autoFocus
              />
            </div>
            {customerResults.length > 0 && (
              <div className="cc-card max-h-40 divide-y divide-border-subtle overflow-y-auto">
                {customerResults.map((result) => (
                  <button
                    key={result.shopify.gid}
                    type="button"
                    disabled={resolving}
                    onClick={() => pickCustomer(result)}
                    className={cn("flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-60")}
                  >
                    <span className="font-medium text-ink-primary">{result.shopify.displayName}</span>
                    <span className="text-xs text-ink-tertiary">
                      {[result.shopify.company, result.shopify.email].filter(Boolean).join(" · ") || "Geen contactgegevens"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {selectedCustomer && (
          <div className="flex items-center justify-between rounded-md border border-border-subtle bg-canvas px-3 py-2 text-sm">
            <span>
              Klant: <span className="font-medium text-ink-primary">{selectedCustomer.name}</span>
            </span>
            {!fixedCustomer && (
              <button type="button" onClick={() => setSelectedCustomer(null)} className="text-xs text-accent-600 hover:underline">
                Wijzigen
              </button>
            )}
          </div>
        )}

        <Input label="Titel" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bijv. Terras + zwembadproject" autoFocus={!!selectedCustomer} />
        <Textarea label="Omschrijving (optioneel)" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Geschatte waarde (€, optioneel)"
            type="number"
            min={0}
            step="0.01"
            value={estimatedValue}
            onChange={(e) => setEstimatedValue(e.target.value)}
          />
          <Input
            label="Kans % (optioneel)"
            type="number"
            min={0}
            max={100}
            value={probability}
            onChange={(e) => setProbability(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Verwachte sluitdatum (optioneel)"
            type="date"
            value={expectedCloseDate}
            onChange={(e) => setExpectedCloseDate(e.target.value)}
          />
          <Select label="Eigenaar (optioneel)" value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
            <option value="">Standaard (accountmanager of jij)</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Dialog>
  );
}

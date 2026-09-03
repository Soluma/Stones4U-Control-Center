"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { LINK_TYPE_LABEL, type OpportunityLinkTypeCode } from "@/modules/opportunities/labels";

export type CandidateItem = {
  linkType: OpportunityLinkTypeCode;
  externalRef: string;
  title: string;
  subtitle: string;
  amount: string | null;
  adminUrl: string | null;
};

export type LinkedItem = {
  id: string;
  linkType: OpportunityLinkTypeCode;
  externalRef: string;
};

function key(linkType: string, externalRef: string) {
  return `${linkType}:${externalRef}`;
}

// Phase 4a — always shows candidates already fetched server-side from the
// existing live adapters (never a local copy of the quote/order itself,
// ADR-009 §4). Linking/unlinking is always an explicit human click, never
// automatic.
export function OpportunityCommercialLinks({
  opportunityId,
  canEdit,
  links,
  candidates,
}: {
  opportunityId: string;
  canEdit: boolean;
  links: LinkedItem[];
  candidates: CandidateItem[];
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const linkedByKey = new Map(links.map((l) => [key(l.linkType, l.externalRef), l]));

  async function addLink(candidate: CandidateItem) {
    setBusyKey(key(candidate.linkType, candidate.externalRef));
    await fetch(`/api/opportunities/${opportunityId}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkType: candidate.linkType, externalRef: candidate.externalRef }),
    });
    setBusyKey(null);
    router.refresh();
  }

  async function removeLink(linkId: string, k: string) {
    setBusyKey(k);
    await fetch(`/api/opportunities/${opportunityId}/links/${linkId}`, { method: "DELETE" });
    setBusyKey(null);
    router.refresh();
  }

  if (candidates.length === 0) {
    return (
      <EmptyState
        title="Geen offertes of bestellingen gevonden"
        description="Er is nog geen commerciële activiteit bekend voor deze klant om te koppelen."
      />
    );
  }

  return (
    <div className="cc-card divide-y divide-border-subtle">
      {candidates.map((candidate) => {
        const k = key(candidate.linkType, candidate.externalRef);
        const linkRow = linkedByKey.get(k);
        return (
          <div key={k} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink-primary">
                {candidate.adminUrl ? (
                  <a href={candidate.adminUrl} target="_blank" rel="noreferrer noopener" className="hover:underline">
                    {candidate.title}
                  </a>
                ) : (
                  candidate.title
                )}
              </p>
              <p className="mt-0.5 truncate text-xs text-ink-tertiary">
                {LINK_TYPE_LABEL[candidate.linkType]} · {candidate.subtitle}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {candidate.amount && <span className="text-xs font-medium tabular-nums text-ink-secondary">{candidate.amount}</span>}
              {linkRow ? (
                <>
                  <Badge tone="success">Gekoppeld</Badge>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Unlink className="h-3.5 w-3.5" />}
                      loading={busyKey === k}
                      onClick={() => removeLink(linkRow.id, k)}
                    >
                      Ontkoppelen
                    </Button>
                  )}
                </>
              ) : (
                canEdit && (
                  <Button variant="secondary" size="sm" icon={<Link2 className="h-3.5 w-3.5" />} loading={busyKey === k} onClick={() => addLink(candidate)}>
                    Koppelen
                  </Button>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trophy, XCircle, RotateCcw, Archive } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { STAGE_ORDER, STAGE_LABEL, type OpportunityStageCode } from "@/modules/opportunities/labels";

type AssignableUser = { id: string; name: string };

export function OpportunityActions({
  opportunityId,
  stage,
  status,
  ownerUserId,
  estimatedValue,
  canEdit,
}: {
  opportunityId: string;
  stage: OpportunityStageCode;
  status: "OPEN" | "WON" | "LOST";
  ownerUserId: string;
  estimatedValue: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [wonDialogOpen, setWonDialogOpen] = useState(false);
  const [finalValue, setFinalValue] = useState(estimatedValue ?? "");
  const [lostDialogOpen, setLostDialogOpen] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (canEdit) {
      fetch("/api/users/assignable")
        .then((r) => r.json())
        .then((data) => setUsers(data.users ?? []));
    }
  }, [canEdit]);

  async function call(path: string, body?: unknown, method: "POST" | "PATCH" = "POST") {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/opportunities/${opportunityId}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setError(data?.error ?? "Actie mislukt.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function handleStageChange(newStage: string) {
    await call("/stage", { stage: newStage }, "PATCH");
  }

  async function handleOwnerChange(newOwnerUserId: string) {
    if (!newOwnerUserId) return;
    await call("/owner", { ownerUserId: newOwnerUserId }, "PATCH");
  }

  async function handleWon() {
    const ok = await call("/won", { finalValue: finalValue || undefined });
    if (ok) setWonDialogOpen(false);
  }

  async function handleLost() {
    if (lostReason.trim().length === 0) return;
    const ok = await call("/lost", { lostReason });
    if (ok) setLostDialogOpen(false);
  }

  async function handleReopen() {
    await call("/reopen");
  }

  async function handleArchive() {
    if (!confirm("Deze verkoopkans archiveren? Ze verdwijnt dan uit de actieve pipeline maar blijft bewaard.")) return;
    await call("/archive");
  }

  if (!canEdit) return null;

  return (
    <div className="cc-card space-y-3 p-4">
      {error && <p className="text-xs text-danger-500">{error}</p>}

      {status === "OPEN" && (
        <Select label="Fase" value={stage} disabled={busy} onChange={(e) => handleStageChange(e.target.value)}>
          {STAGE_ORDER.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </Select>
      )}

      <Select label="Eigenaar" value={ownerUserId} disabled={busy} onChange={(e) => handleOwnerChange(e.target.value)}>
        {!users.some((u) => u.id === ownerUserId) && <option value={ownerUserId}>Huidige eigenaar</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </Select>

      <div className="flex flex-wrap gap-2 pt-1">
        {status === "OPEN" && (
          <>
            <Button variant="primary" size="sm" icon={<Trophy className="h-3.5 w-3.5" />} onClick={() => setWonDialogOpen(true)}>
              Gewonnen
            </Button>
            <Button variant="danger" size="sm" icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setLostDialogOpen(true)}>
              Verloren
            </Button>
          </>
        )}
        {status !== "OPEN" && (
          <Button variant="secondary" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy} onClick={handleReopen}>
            Heropenen
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={<Archive className="h-3.5 w-3.5" />} loading={busy} onClick={handleArchive}>
          Archiveren
        </Button>
      </div>

      <Dialog
        open={wonDialogOpen}
        onClose={() => setWonDialogOpen(false)}
        title="Verkoopkans gewonnen"
        footer={
          <>
            <Button variant="secondary" onClick={() => setWonDialogOpen(false)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={busy} onClick={handleWon}>
              Bevestigen
            </Button>
          </>
        }
      >
        <Input
          label="Definitieve waarde (€, optioneel)"
          type="number"
          min={0}
          step="0.01"
          value={finalValue}
          onChange={(e) => setFinalValue(e.target.value)}
          hint="Leeg laten om de geschatte waarde te gebruiken."
        />
      </Dialog>

      <Dialog
        open={lostDialogOpen}
        onClose={() => setLostDialogOpen(false)}
        title="Verkoopkans verloren"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLostDialogOpen(false)}>
              Annuleren
            </Button>
            <Button variant="danger" loading={busy} disabled={lostReason.trim().length === 0} onClick={handleLost}>
              Bevestigen
            </Button>
          </>
        }
      >
        <Textarea label="Reden van verlies" value={lostReason} onChange={(e) => setLostReason(e.target.value)} rows={3} autoFocus />
      </Dialog>
    </div>
  );
}

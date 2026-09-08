import { notFound } from "next/navigation";
import { Truck } from "lucide-react";
import { getHandoffByRawToken } from "@/modules/delivery/delivery-handoff.service";
import { DeliveryDateForm } from "./DeliveryDateForm";

// Public, unauthenticated route — no getSessionUser()/requireUser() call,
// same precedent as src/app/login (the only other public page in this
// app). Authorization is the opaque token itself, never a session.

type PageProps = { params: Promise<{ token: string }> };

export default async function DeliveryDatePage({ params }: PageProps) {
  const { token } = await params;
  const handoff = await getHandoffByRawToken(token);

  // Generic 404 for any unresolved token — never distinguishes "malformed"
  // from "unknown, possibly valid-shaped" (avoids leaking which is which).
  if (!handoff) notFound();

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent-500 text-white">
            <Truck className="h-5 w-5" aria-hidden />
          </div>
          <p className="text-lg font-semibold tracking-tight text-ink-primary">Gewenste leverdatum</p>
          <p className="mt-1 text-sm text-ink-tertiary">
            Geef aan op welke datum u de bestelling bij voorkeur geleverd wilt hebben. Wij proberen hier zoveel
            mogelijk rekening mee te houden. De definitieve leverdatum wordt door Stones4U bevestigd.
          </p>
        </div>
        <div className="cc-card p-6">
          <DeliveryDateForm
            token={token}
            currentValue={handoff.requestedDeliveryDate ? handoff.requestedDeliveryDate.toISOString().slice(0, 10) : ""}
          />
        </div>
      </div>
    </div>
  );
}

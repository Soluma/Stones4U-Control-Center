"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";

// Root error boundary — catches any unhandled error from a Server/Client
// Component render (e.g. a database outage) so the user always sees a safe,
// on-brand message instead of Next.js's generic default page. Never renders
// `error.message`/`error.stack` — those can contain internal details (a
// Prisma connection string fragment, a file path) and are logged
// server-side only. Added during the Phase 1 production readiness review
// (docs/build/PHASE-1-PRODUCTION-READINESS.md, "Error/failure states").
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("unhandled_render_error", { digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger-50 text-danger-500">
          <AlertTriangle className="h-5 w-5" aria-hidden />
        </div>
        <p className="text-lg font-semibold text-ink-primary">Er is iets misgegaan</p>
        <p className="mt-2 text-sm text-ink-tertiary">
          Probeer het opnieuw. Als dit blijft gebeuren, neem contact op met beheer.
        </p>
        <Button variant="primary" onClick={() => reset()} className="mt-4">
          Opnieuw proberen
        </Button>
      </div>
    </div>
  );
}

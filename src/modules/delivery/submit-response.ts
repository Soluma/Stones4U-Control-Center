// Phase 6D — the public POST /api/delivery/[token] response contract.
// Deliberately its own type-only file (no "server-only" guard): imported
// by the route (which constructs it) and by the public "use client" form
// components (which branch on it), so the client only ever acts on a
// server-declared `outcome`, never on the mere presence/absence of a
// field like `redirectUrl`.
export type DeliveryDateSubmitResponse =
  | { outcome: "REDIRECT"; redirectUrl: string }
  | { outcome: "COMPLETED"; requestedDeliveryDate: string };

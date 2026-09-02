// TelefoonSysteem adapter — read-only projection of call/contact-note
// activity into the Control Center Activity Timeline (docs/architecture/
// ADR-004, "B. External/source activities").
//
// STATUS: DISABLED IN PHASE 1. TelefoonSysteem's API requires a human-
// oriented JWT login (email+password → 7-day bearer token, no service-
// account concept, no scoped machine-to-machine credential — see
// docs/platform-discovery/19 §4 and 22). The only way to call it today would
// be to log in as a dedicated human "VIEWER" account and store that
// account's password server-side as a pseudo-service-credential. That is
// exactly the "onveilige workaround" this build was explicitly told not to
// build (see the build instructions for this phase, section K). So: this
// adapter is implemented as an interface only, wired to
// DisabledTelephonyAdapter, and TelefoonSysteem itself is NOT modified,
// called, or logged into anywhere in this codebase.
//
// To enable this adapter in a later phase, TelefoonSysteem needs a real
// service-to-service credential — e.g. an extension of its existing
// INTERNAL_SECRET/x-internal-secret pattern (docs/platform-discovery/14,
// "Internal service authentication") issued specifically to Control Center.
// That requires a (small, isolated) code change in TelefoonSysteem itself,
// which is out of scope for this repository and this phase.

export type TelephonyActivityItem = {
  id: string;
  occurredAt: string;
  title: string;
  summary?: string;
  direction?: "inbound" | "outbound";
  phoneNumber?: string;
};

export type TelephonyAdapterStatus =
  | { available: true }
  | { available: false; reason: string };

export interface TelephonyAdapter {
  status(): TelephonyAdapterStatus;
  /** Read-only. Returns call/note activity for a customer, matched by phone
   * number(s), for projection into the Activity Timeline. Must return an
   * empty array (never throw) when the adapter is disabled or unreachable —
   * a Customer 360 page must never break because telephony data is
   * unavailable (docs/platform-discovery/25 §8). */
  getActivityForPhoneNumbers(phoneNumbers: string[]): Promise<TelephonyActivityItem[]>;
}

export class DisabledTelephonyAdapter implements TelephonyAdapter {
  status(): TelephonyAdapterStatus {
    return {
      available: false,
      reason:
        "TelefoonSysteem heeft nog geen machine-tot-machine service-auth; zie src/integrations/telephony/adapter.ts.",
    };
  }

  async getActivityForPhoneNumbers(): Promise<TelephonyActivityItem[]> {
    return [];
  }
}

export function createTelephonyAdapter(): TelephonyAdapter {
  return new DisabledTelephonyAdapter();
}

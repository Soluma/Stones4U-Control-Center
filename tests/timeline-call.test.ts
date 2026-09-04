import { describe, expect, it } from "vitest";
import { callToTimelineItem } from "@/modules/activity/timeline";
import type { TelephonyActivityItem } from "@/integrations/telephony/adapter";
import type { ContactIdentity } from "@/modules/crm/contact-timeline";

function baseCall(overrides: Partial<TelephonyActivityItem> = {}): TelephonyActivityItem {
  return {
    id: "call-1",
    occurredAt: "2026-09-01T09:00:00Z",
    title: "Inkomend gesprek",
    summary: "Vraag over levering",
    phoneNumber: "0612345678",
    ...overrides,
  };
}

describe("callToTimelineItem", () => {
  it("produces a stable, prefixed id and kind CALL", () => {
    const item = callToTimelineItem(baseCall());
    expect(item.id).toBe("telefoon-call-1");
    expect(item.kind).toBe("CALL");
    expect(item.source).toBe("TELEFOONSYSTEEM");
  });

  it("carries the raw phoneNumber through, regardless of contact match", () => {
    const item = callToTimelineItem(baseCall());
    expect(item.phoneNumber).toBe("0612345678");
  });

  it("sets customerContactId on an exact, unambiguous phone match", () => {
    const contacts: ContactIdentity[] = [
      { id: "contact-1", displayName: "Klant Naam", emailNormalized: null, phoneNormalized: "31612345678" },
    ];
    const item = callToTimelineItem(baseCall(), contacts);
    expect(item.customerContactId).toBe("contact-1");
    expect(item.title).toBe("Inkomend gesprek — Klant Naam");
  });

  it("leaves customerContactId null (never guesses) when no contact matches", () => {
    const item = callToTimelineItem(baseCall(), []);
    expect(item.customerContactId).toBeNull();
    expect(item.title).toBe("Inkomend gesprek");
  });

  it("leaves customerContactId null (never guesses) when the number matches more than one active contact", () => {
    const contacts: ContactIdentity[] = [
      { id: "contact-1", displayName: "Klant A", emailNormalized: null, phoneNormalized: "31612345678" },
      { id: "contact-2", displayName: "Klant B", emailNormalized: null, phoneNormalized: "31612345678" },
    ];
    const item = callToTimelineItem(baseCall(), contacts);
    expect(item.customerContactId).toBeNull();
  });

  it("leaves phoneNumber undefined when the call has none — never a broken quick action", () => {
    const item = callToTimelineItem(baseCall({ phoneNumber: undefined }));
    expect(item.phoneNumber).toBeUndefined();
    expect(item.customerContactId).toBeNull();
  });
});

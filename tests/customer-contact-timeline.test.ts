import { describe, expect, it } from "vitest";
import { matchContactByEmail, matchContactByPhone, type ContactIdentity } from "@/modules/crm/contact-timeline";
import { emailToTimelineItem } from "@/modules/activity/timeline";
import type { NormalizedEmailMessage } from "@/integrations/email/types";

// Phase 4C timeline naming enrichment — pure, in-memory tests, no database
// (docs/platform-discovery/38-PHASE-4C-CONTACTS-ARCHITECTURE.md §12).

const jan: ContactIdentity = { id: "c1", displayName: "Jan Jansen", emailNormalized: "jan@jansentuinen.nl", phoneNormalized: "31612345678" };
const piet: ContactIdentity = { id: "c2", displayName: "Piet de Vries", emailNormalized: "piet@jansentuinen.nl", phoneNormalized: "31687654321" };

describe("matchContactByEmail", () => {
  it("returns the single exact match", () => {
    expect(matchContactByEmail([jan, piet], "jan@jansentuinen.nl")).toEqual(jan);
  });

  it("returns null when the address matches no contact", () => {
    expect(matchContactByEmail([jan, piet], "onbekend@jansentuinen.nl")).toBeNull();
  });

  it("returns null (never guesses) when two contacts share the same normalized email", () => {
    const duplicate: ContactIdentity = { id: "c3", displayName: "Gedeeld Adres", emailNormalized: "info@jansentuinen.nl", phoneNormalized: null };
    const duplicate2: ContactIdentity = { id: "c4", displayName: "Ook Gedeeld", emailNormalized: "info@jansentuinen.nl", phoneNormalized: null };
    expect(matchContactByEmail([duplicate, duplicate2], "info@jansentuinen.nl")).toBeNull();
  });

  it("returns null for a null address", () => {
    expect(matchContactByEmail([jan], null)).toBeNull();
  });
});

describe("matchContactByPhone", () => {
  it("returns the single exact match", () => {
    expect(matchContactByPhone([jan, piet], "31687654321")).toEqual(piet);
  });

  it("returns null when no contact matches", () => {
    expect(matchContactByPhone([jan, piet], "31699999999")).toBeNull();
  });

  it("returns null for a null number", () => {
    expect(matchContactByPhone([jan, piet], null)).toBeNull();
  });
});

function baseMessage(overrides: Partial<NormalizedEmailMessage> = {}): NormalizedEmailMessage {
  return {
    provider: "IMAP",
    mailboxId: "mailbox-1",
    mailboxAddress: "info@stones4u.eu",
    externalMessageId: "msg-1",
    conversationId: null,
    subject: "Test onderwerp",
    from: { address: "jan@jansentuinen.nl", name: "J. Jansen (via headers)" },
    to: [{ address: "info@stones4u.eu", name: null }],
    cc: [],
    occurredAt: new Date("2026-09-03T10:00:00.000Z"),
    direction: "INBOUND",
    bodyPreview: "Hallo, ...",
    webLink: null,
    ...overrides,
  };
}

describe("emailToTimelineItem — contact name enrichment", () => {
  it("uses the matched contact's displayName instead of the raw header name for an inbound message", () => {
    const item = emailToTimelineItem(baseMessage(), [jan, piet]);
    expect(item.title).toBe("E-mail van Jan Jansen");
  });

  it("falls back to the raw header name/address when no contact matches", () => {
    const item = emailToTimelineItem(baseMessage({ from: { address: "onbekend@elders.nl", name: "Onbekend Persoon" } }), [jan, piet]);
    expect(item.title).toBe("E-mail van Onbekend Persoon");
  });

  it("behaves exactly as before (no enrichment) when contacts is omitted — existing callers unaffected", () => {
    const item = emailToTimelineItem(baseMessage());
    expect(item.title).toBe("E-mail van J. Jansen (via headers)");
  });

  it("enriches an outbound message using the first recipient's matched contact", () => {
    const item = emailToTimelineItem(
      baseMessage({ direction: "OUTBOUND", from: { address: "info@stones4u.eu", name: null }, to: [{ address: "piet@jansentuinen.nl", name: "Onbekende weergavenaam" }] }),
      [jan, piet],
    );
    expect(item.title).toBe("E-mail naar Piet de Vries");
  });

  it("never shows a contact name for an address that matches two contacts within the same customer (ambiguous)", () => {
    const duplicate1: ContactIdentity = { id: "d1", displayName: "Dup Een", emailNormalized: "gedeeld@bedrijf.nl", phoneNormalized: null };
    const duplicate2: ContactIdentity = { id: "d2", displayName: "Dup Twee", emailNormalized: "gedeeld@bedrijf.nl", phoneNormalized: null };
    const item = emailToTimelineItem(baseMessage({ from: { address: "gedeeld@bedrijf.nl", name: "Header Naam" } }), [duplicate1, duplicate2]);
    expect(item.title).toBe("E-mail van Header Naam");
  });

  it("appends the +N suffix for outbound messages to multiple recipients even with a matched contact", () => {
    const item = emailToTimelineItem(
      baseMessage({
        direction: "OUTBOUND",
        from: { address: "info@stones4u.eu", name: null },
        to: [
          { address: "piet@jansentuinen.nl", name: null },
          { address: "collega@jansentuinen.nl", name: null },
        ],
      }),
      [jan, piet],
    );
    expect(item.title).toBe("E-mail naar Piet de Vries (+1)");
  });
});

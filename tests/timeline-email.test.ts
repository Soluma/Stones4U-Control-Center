import { describe, expect, it } from "vitest";
import { emailToTimelineItem } from "@/modules/activity/timeline";
import type { NormalizedEmailMessage } from "@/integrations/email/types";
import type { ContactIdentity } from "@/modules/crm/contact-timeline";

function baseMessage(overrides: Partial<NormalizedEmailMessage> = {}): NormalizedEmailMessage {
  return {
    provider: "MICROSOFT365",
    mailboxId: "mailbox-1",
    mailboxAddress: "info@stones4u.nl",
    externalMessageId: "msg-1",
    conversationId: "conv-1",
    subject: "Vraag over levering",
    from: { address: "klant@voorbeeld.nl", name: "Klant Naam" },
    to: [{ address: "info@stones4u.nl", name: "Stones4U" }],
    cc: [],
    occurredAt: new Date("2026-09-01T09:00:00Z"),
    direction: "INBOUND",
    bodyPreview: "Korte samenvatting...",
    webLink: "https://outlook.office.com/mail/id/1",
    ...overrides,
  };
}

describe("emailToTimelineItem", () => {
  it("projects an inbound message with kind EMAIL_INBOUND and a provider-prefixed, mailbox-scoped id", () => {
    const item = emailToTimelineItem(baseMessage());
    expect(item.kind).toBe("EMAIL_INBOUND");
    expect(item.source).toBe("MICROSOFT365");
    expect(item.id).toBe("m365-mailbox-1-msg-1");
    expect(item.title).toBe("E-mail van Klant Naam");
    expect(item.summary).toBe("Vraag over levering");
  });

  it("projects an outbound message with kind EMAIL_OUTBOUND", () => {
    const item = emailToTimelineItem(
      baseMessage({
        direction: "OUTBOUND",
        from: { address: "info@stones4u.nl", name: "Stones4U" },
        to: [{ address: "klant@voorbeeld.nl", name: "Klant Naam" }],
      }),
    );
    expect(item.kind).toBe("EMAIL_OUTBOUND");
    expect(item.title).toBe("E-mail naar Klant Naam");
  });

  it("indicates additional recipients in the title when there is more than one", () => {
    const item = emailToTimelineItem(
      baseMessage({
        direction: "OUTBOUND",
        from: { address: "info@stones4u.nl", name: "Stones4U" },
        to: [
          { address: "klant-a@voorbeeld.nl", name: "Klant A" },
          { address: "klant-b@voorbeeld.nl", name: "Klant B" },
        ],
        cc: [{ address: "collega@stones4u.nl", name: "Collega" }],
      }),
    );
    expect(item.title).toBe("E-mail naar Klant A (+2)");
  });

  it("falls back to bodyPreview for the summary when there is no subject", () => {
    const item = emailToTimelineItem(baseMessage({ subject: null }));
    expect(item.summary).toBe("Korte samenvatting...");
  });

  it("produces a distinctly-prefixed id per provider so two providers can never collide", () => {
    const m365Item = emailToTimelineItem(baseMessage({ provider: "MICROSOFT365", mailboxId: "mb-1", externalMessageId: "same-id" }));
    const imapItem = emailToTimelineItem(baseMessage({ provider: "IMAP", mailboxId: "mb-1", externalMessageId: "same-id" }));
    expect(m365Item.id).not.toBe(imapItem.id);
    expect(m365Item.id).toBe("m365-mb-1-same-id");
    expect(imapItem.id).toBe("imap-mb-1-same-id");
  });
});

describe("emailToTimelineItem — Phase 6c quick-action fields", () => {
  it("carries the counterpart's raw address as participantEmail, regardless of contact match", () => {
    const item = emailToTimelineItem(baseMessage());
    expect(item.participantEmail).toBe("klant@voorbeeld.nl");
  });

  it("sets customerContactId on an exact, unambiguous contact match", () => {
    const contacts: ContactIdentity[] = [
      { id: "contact-1", displayName: "Klant Naam", emailNormalized: "klant@voorbeeld.nl", phoneNormalized: null },
    ];
    const item = emailToTimelineItem(baseMessage(), contacts);
    expect(item.customerContactId).toBe("contact-1");
  });

  it("leaves customerContactId null (never guesses) when no contact matches", () => {
    const item = emailToTimelineItem(baseMessage(), []);
    expect(item.customerContactId).toBeNull();
  });

  it("leaves customerContactId null (never guesses) when the address matches more than one active contact", () => {
    const contacts: ContactIdentity[] = [
      { id: "contact-1", displayName: "Klant Naam", emailNormalized: "klant@voorbeeld.nl", phoneNormalized: null },
      { id: "contact-2", displayName: "Ander Contact", emailNormalized: "klant@voorbeeld.nl", phoneNormalized: null },
    ];
    const item = emailToTimelineItem(baseMessage(), contacts);
    expect(item.customerContactId).toBeNull();
  });

  it("never leaks the message body/subject into anything but summary — participantEmail/customerContactId carry only identity, not content", () => {
    const item = emailToTimelineItem(baseMessage({ subject: "Geheim onderwerp", bodyPreview: "Geheime inhoud" }));
    expect(item.participantEmail).not.toContain("Geheim");
    expect(item.customerContactId ?? "").not.toContain("Geheim");
  });
});

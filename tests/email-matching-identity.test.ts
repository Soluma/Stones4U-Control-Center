import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { recordMatchesForMessages } from "@/integrations/email/adapter";
import { stableEmailId } from "@/integrations/email/types";
import type { NormalizedEmailMessage, NormalizedEmailParticipant } from "@/integrations/email/types";

// Direct, focused tests of the ADR-007 correction (docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md):
// ExternalContactMatch.externalRef for EMAIL is the contact IDENTITY
// (normalized external email address), never a message id — one row per
// distinct external address per customer, regardless of how many messages
// involve it. Constructs NormalizedEmailMessage fixtures directly (no
// HTTP/IMAP mocking needed) so each scenario is precise and cheap.

const MAILBOX_ADDRESS = "info@stones4u.eu";
const MAILBOX_ID = "mailbox-test-1";

function participant(address: string, name: string | null = null): NormalizedEmailParticipant {
  return { address, name };
}

function inboundMessage(overrides: Partial<NormalizedEmailMessage> = {}): NormalizedEmailMessage {
  return {
    provider: "IMAP",
    mailboxId: MAILBOX_ID,
    mailboxAddress: MAILBOX_ADDRESS,
    externalMessageId: `1-${Math.random()}`,
    conversationId: null,
    subject: "Vraag",
    from: participant("klant@voorbeeld.nl", "Klant"),
    to: [participant(MAILBOX_ADDRESS)],
    cc: [],
    occurredAt: new Date("2026-09-01T09:00:00Z"),
    direction: "INBOUND",
    bodyPreview: "preview",
    webLink: null,
    ...overrides,
  };
}

function outboundMessage(overrides: Partial<NormalizedEmailMessage> = {}): NormalizedEmailMessage {
  return {
    provider: "IMAP",
    mailboxId: MAILBOX_ID,
    mailboxAddress: MAILBOX_ADDRESS,
    externalMessageId: `2-${Math.random()}`,
    conversationId: null,
    subject: "Antwoord",
    from: participant(MAILBOX_ADDRESS),
    to: [participant("klant@voorbeeld.nl", "Klant")],
    cc: [],
    occurredAt: new Date("2026-09-02T09:00:00Z"),
    direction: "OUTBOUND",
    bodyPreview: "preview",
    webLink: null,
    ...overrides,
  };
}

async function createProfile(email: string, displayName = "Test Klant") {
  return prisma.customerProfile.create({
    data: { shopifyCustomerGid: `gid://shopify/Customer/${crypto.randomUUID()}`, displayName, email },
  });
}

describe("recordMatchesForMessages — identity-level ExternalContactMatch (real DB)", () => {
  const profileIds: string[] = [];

  afterEach(async () => {
    for (const id of profileIds.splice(0)) {
      await prisma.externalContactMatch.deleteMany({ where: { customerProfileId: id } });
      await prisma.customerProfile.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("25 messages from the same external address -> exactly one ExternalContactMatch row", async () => {
    const profile = await createProfile("klant@voorbeeld.nl");
    profileIds.push(profile.id);

    const messages = Array.from({ length: 25 }, () => inboundMessage());
    await recordMatchesForMessages(messages);

    const matches = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profile.id, source: "EMAIL" } });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.externalRef).toBe("klant@voorbeeld.nl");
    expect(matches[0]?.confidence).toBe("EXACT");
  });

  it("inbound and outbound messages with the same external address -> one match, not two", async () => {
    const profile = await createProfile("klant@voorbeeld.nl");
    profileIds.push(profile.id);

    await recordMatchesForMessages([inboundMessage(), outboundMessage(), inboundMessage(), outboundMessage()]);

    const matches = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profile.id, source: "EMAIL" } });
    expect(matches).toHaveLength(1);
  });

  it("multiple different external addresses -> one match per distinct identity", async () => {
    const profileA = await createProfile("klant-a@voorbeeld.nl", "Klant A");
    const profileB = await createProfile("klant-b@voorbeeld.nl", "Klant B");
    profileIds.push(profileA.id, profileB.id);

    await recordMatchesForMessages([
      inboundMessage({ from: participant("klant-a@voorbeeld.nl") }),
      inboundMessage({ from: participant("klant-a@voorbeeld.nl") }),
      inboundMessage({ from: participant("klant-b@voorbeeld.nl") }),
    ]);

    const matchesA = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profileA.id, source: "EMAIL" } });
    const matchesB = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profileB.id, source: "EMAIL" } });
    expect(matchesA).toHaveLength(1);
    expect(matchesA[0]?.externalRef).toBe("klant-a@voorbeeld.nl");
    expect(matchesB).toHaveLength(1);
    expect(matchesB[0]?.externalRef).toBe("klant-b@voorbeeld.nl");
  });

  it("normalization: Example@Domain.nl and example@domain.nl converge on the same externalRef", async () => {
    const profile = await createProfile("example@domain.nl");
    profileIds.push(profile.id);

    await recordMatchesForMessages([
      inboundMessage({ from: participant("Example@Domain.nl") }),
      inboundMessage({ from: participant("  example@domain.nl  ") }),
    ]);

    const matches = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profile.id, source: "EMAIL" } });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.externalRef).toBe("example@domain.nl");
  });

  it("never records the monitored mailbox's own address as an external identity", async () => {
    // Outbound message where the only "to" participant IS the mailbox
    // itself (e.g. a self-addressed test mail) — must record nothing.
    await recordMatchesForMessages([outboundMessage({ to: [participant(MAILBOX_ADDRESS)] })]);

    const matches = await prisma.externalContactMatch.findMany({ where: { externalRef: MAILBOX_ADDRESS, source: "EMAIL" } });
    expect(matches).toHaveLength(0);
  });

  it("multiple TO/CC recipients on one outbound message: distinct emails -> distinct identities", async () => {
    const profileTo = await createProfile("to-recipient@voorbeeld.nl", "To Recipient");
    const profileCc = await createProfile("cc-recipient@voorbeeld.nl", "Cc Recipient");
    profileIds.push(profileTo.id, profileCc.id);

    await recordMatchesForMessages([
      outboundMessage({
        to: [participant("to-recipient@voorbeeld.nl"), participant(MAILBOX_ADDRESS)],
        cc: [participant("cc-recipient@voorbeeld.nl")],
      }),
    ]);

    const matchesTo = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profileTo.id, source: "EMAIL" } });
    const matchesCc = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profileCc.id, source: "EMAIL" } });
    expect(matchesTo).toHaveLength(1);
    expect(matchesCc).toHaveLength(1);
    // The mailbox's own address (also present in `to`) must never appear as its own match.
    const mailboxSelfMatches = await prisma.externalContactMatch.findMany({ where: { externalRef: MAILBOX_ADDRESS, source: "EMAIL" } });
    expect(mailboxSelfMatches).toHaveLength(0);
  });

  it("ambiguous customer-email: existing AMBIGUOUS semantics preserved (never silently picked)", async () => {
    const profileA = await createProfile("shared@voorbeeld.nl", "Klant A");
    const profileB = await createProfile("shared@voorbeeld.nl", "Klant B");
    profileIds.push(profileA.id, profileB.id);

    // Even across many messages from the shared address, still just one
    // AMBIGUOUS row per candidate profile — not one per message.
    await recordMatchesForMessages([
      inboundMessage({ from: participant("shared@voorbeeld.nl") }),
      inboundMessage({ from: participant("shared@voorbeeld.nl") }),
      inboundMessage({ from: participant("shared@voorbeeld.nl") }),
    ]);

    const matchesA = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profileA.id, source: "EMAIL" } });
    const matchesB = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profileB.id, source: "EMAIL" } });
    expect(matchesA).toHaveLength(1);
    expect(matchesB).toHaveLength(1);
    expect(matchesA[0]?.confidence).toBe("AMBIGUOUS");
    expect(matchesB[0]?.confidence).toBe("AMBIGUOUS");
    expect(matchesA[0]?.confirmedByUserId).toBeNull();
    expect(matchesB[0]?.confirmedByUserId).toBeNull();
  });

  it("repeated Customer 360 loads (re-running the same batch) never grow the row count", async () => {
    const profile = await createProfile("klant@voorbeeld.nl");
    profileIds.push(profile.id);

    const messages = [inboundMessage(), outboundMessage()];
    await recordMatchesForMessages(messages);
    await recordMatchesForMessages(messages); // simulates a page refresh
    await recordMatchesForMessages([...messages, inboundMessage()]); // simulates a new message arriving on a later visit

    const matches = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profile.id, source: "EMAIL" } });
    expect(matches).toHaveLength(1); // still just the one identity row
  });

  it("no candidate CustomerProfile -> records nothing (unmatched, not an error)", async () => {
    await recordMatchesForMessages([inboundMessage({ from: participant("nobody-known@nergens.example") })]);
    const matches = await prisma.externalContactMatch.findMany({ where: { externalRef: "nobody-known@nergens.example" } });
    expect(matches).toHaveLength(0);
  });

  it("identity vs. interaction: externalRef is the contact address, never stableEmailId()'s message-scoped form", async () => {
    const profile = await createProfile("klant@voorbeeld.nl");
    profileIds.push(profile.id);

    const message = inboundMessage({ externalMessageId: "999-42" });
    await recordMatchesForMessages([message]);

    const matches = await prisma.externalContactMatch.findMany({ where: { customerProfileId: profile.id, source: "EMAIL" } });
    expect(matches).toHaveLength(1);

    // The two concepts must never collide: stableEmailId() (Timeline,
    // interaction-scoped) and ExternalContactMatch.externalRef (matching,
    // identity-scoped) are deliberately different values for the same message.
    const timelineId = stableEmailId(message);
    expect(timelineId).toBe(`imap-${MAILBOX_ID}-999-42`);
    expect(matches[0]?.externalRef).not.toBe(timelineId);
    expect(matches[0]?.externalRef).toBe("klant@voorbeeld.nl");
  });
});

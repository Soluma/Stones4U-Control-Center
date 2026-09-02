import { describe, expect, it } from "vitest";
import { createTelephonyAdapter } from "@/integrations/telephony/adapter";
import { createExactHistoryAdapter } from "@/integrations/exact/adapter";
import { createQuotesAdapter } from "@/integrations/quotes/adapter";

// Phase 1 has no safe machine-to-machine credential for TelefoonSysteem or
// Exact (docs/build/PHASE-1-IMPLEMENTATION-REPORT.md), and no read API at
// all for OfferteApp/s4u-quote-app — every adapter must therefore report
// itself unavailable and degrade to an empty/null result, NEVER throw, so a
// Customer 360 page never breaks because an external system is disabled or
// unreachable (docs/platform-discovery/25 §8).

describe("disabled adapters fail safe", () => {
  it("DisabledTelephonyAdapter reports unavailable and returns no activity", async () => {
    const adapter = createTelephonyAdapter();
    expect(adapter.status().available).toBe(false);
    await expect(adapter.getActivityForPhoneNumbers(["31612345678"])).resolves.toEqual([]);
  });

  it("DisabledExactHistoryAdapter reports unavailable and returns null", async () => {
    const adapter = createExactHistoryAdapter();
    expect(adapter.status().available).toBe(false);
    await expect(adapter.getSummaryForCustomer({ email: "a@b.com" })).resolves.toBeNull();
  });

  it("DisabledQuotesAdapter reports unavailable and returns no activity", async () => {
    const adapter = createQuotesAdapter();
    expect(adapter.status().available).toBe(false);
    await expect(adapter.getActivityForCustomer({ email: "a@b.com" })).resolves.toEqual([]);
  });
});

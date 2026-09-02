import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStorageConfigured, StorageConfigError, uploadObject, deleteObject, getSignedDownloadUrl, buildR2Endpoint } from "@/integrations/storage/r2";

// No real Cloudflare R2 bucket/credentials exist in this environment
// (docs/build/PHASE-2-IMPLEMENTATION-REPORT.md — operational step for a
// human with Cloudflare account access, exactly like the Shopify custom app
// in Phase 1). What IS fully testable without live credentials is the
// adapter's fail-safe behavior: every operation must fail cleanly with
// StorageConfigError, never throw an opaque error or crash, exactly
// mirroring the telephony/exact "disabled adapter" pattern
// (tests/adapters.test.ts).

const R2_ENV_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_JURISDICTION"] as const;

describe("storage (R2) adapter — not configured", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of R2_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of R2_ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });

  it("isStorageConfigured() is false when any required env var is missing", () => {
    expect(isStorageConfigured()).toBe(false);
  });

  it("uploadObject() rejects with StorageConfigError, never a raw/unhandled error", async () => {
    await expect(uploadObject({ storageKey: "files/x.pdf", body: Buffer.from("x"), mimeType: "application/pdf" })).rejects.toBeInstanceOf(
      StorageConfigError,
    );
  });

  it("deleteObject() rejects with StorageConfigError", async () => {
    await expect(deleteObject("files/x.pdf")).rejects.toBeInstanceOf(StorageConfigError);
  });

  it("getSignedDownloadUrl() rejects with StorageConfigError", async () => {
    await expect(getSignedDownloadUrl({ storageKey: "files/x.pdf", downloadFilename: "x.pdf", inline: false })).rejects.toBeInstanceOf(
      StorageConfigError,
    );
  });

  it("isStorageConfigured() becomes true once all four required variables are set (R2_JURISDICTION stays optional)", () => {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET_NAME = "test-bucket";
    expect(isStorageConfigured()).toBe(true);
  });
});

describe("buildR2Endpoint — jurisdiction-aware endpoint (docs/architecture/ADR-005)", () => {
  const accountId = "abc123def456";

  it("resolves to the default global endpoint when no jurisdiction is given (backwards compatible)", () => {
    expect(buildR2Endpoint(accountId)).toBe(`https://${accountId}.r2.cloudflarestorage.com`);
  });

  it("resolves to the default endpoint for an empty/blank jurisdiction", () => {
    expect(buildR2Endpoint(accountId, "")).toBe(`https://${accountId}.r2.cloudflarestorage.com`);
    expect(buildR2Endpoint(accountId, "   ")).toBe(`https://${accountId}.r2.cloudflarestorage.com`);
  });

  it("resolves to the EU endpoint for R2_JURISDICTION=eu", () => {
    expect(buildR2Endpoint(accountId, "eu")).toBe(`https://${accountId}.eu.r2.cloudflarestorage.com`);
  });

  it("trims and lowercases the jurisdiction value before matching", () => {
    expect(buildR2Endpoint(accountId, "  EU  ")).toBe(`https://${accountId}.eu.r2.cloudflarestorage.com`);
    expect(buildR2Endpoint(accountId, "Eu")).toBe(`https://${accountId}.eu.r2.cloudflarestorage.com`);
  });

  it("falls back to the default endpoint for an unrecognized jurisdiction rather than throwing", () => {
    expect(buildR2Endpoint(accountId, "us")).toBe(`https://${accountId}.r2.cloudflarestorage.com`);
  });
});

describe("storage (R2) adapter — R2_JURISDICTION env wiring", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of R2_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of R2_ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });

  it("isStorageConfigured() is true with R2_JURISDICTION unset — it is optional, not required", () => {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET_NAME = "test-bucket";
    expect(isStorageConfigured()).toBe(true);
  });

  it("isStorageConfigured() is true with R2_JURISDICTION=eu set alongside the required variables", () => {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET_NAME = "test-bucket";
    process.env.R2_JURISDICTION = "eu";
    expect(isStorageConfigured()).toBe(true);
  });
});

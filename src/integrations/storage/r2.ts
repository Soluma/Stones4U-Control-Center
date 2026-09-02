import "server-only";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Cloudflare R2 file storage adapter (docs/architecture/ADR-005,
// docs/platform-discovery/26 §10). R2 is S3-API-compatible, so the AWS SDK
// is used purely as an S3-compatible HTTP client — no AWS account involved.
//
// Same graceful-degradation shape as the telephony/exact adapters
// (src/integrations/telephony/adapter.ts): if R2 credentials are not
// configured, every operation fails cleanly (never throws an opaque error,
// callers map isStorageConfigured() === false to a 503 "not configured"
// response) rather than crashing — no bucket was provisioned as part of
// this build (that is an operational step for a human with Cloudflare
// account access, exactly like the Shopify custom app in Phase 1).

const DOWNLOAD_URL_EXPIRY_SECONDS = 60;

export class StorageConfigError extends Error {
  constructor(message = "Bestandsopslag is nog niet geconfigureerd.") {
    super(message);
    this.name = "StorageConfigError";
  }
}

function readConfig() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET_NAME?.trim();
  // Optional — a bucket created under Cloudflare's EU jurisdiction is only
  // reachable via the eu.r2.cloudflarestorage.com endpoint, not the default
  // global one (see buildR2Endpoint below). Absent/blank means "default",
  // so every configuration that predates this variable keeps working
  // unchanged.
  const jurisdiction = process.env.R2_JURISDICTION?.trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, jurisdiction };
}

export function isStorageConfigured(): boolean {
  return readConfig() !== null;
}

/** Pure and exported so the endpoint logic is directly unit-testable
 * without constructing a real S3Client (docs: Cloudflare R2 buckets are
 * created under a jurisdiction — "default" or "eu" today — and the S3 API
 * endpoint differs per jurisdiction; see
 * https://developers.cloudflare.com/r2/reference/data-location/#available-jurisdictions).
 * Any value other than "eu" (including unset/blank) resolves to the
 * default global endpoint — not a hardcoded one-off special case, but the
 * one jurisdiction this deployment actually needs today; extending to a
 * further jurisdiction is a one-line addition here. */
export function buildR2Endpoint(accountId: string, jurisdiction?: string): string {
  const normalized = jurisdiction?.trim().toLowerCase();
  if (normalized === "eu") {
    return `https://${accountId}.eu.r2.cloudflarestorage.com`;
  }
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

let cachedClient: { client: S3Client; bucket: string } | null = null;

function getClient(): { client: S3Client; bucket: string } {
  const config = readConfig();
  if (!config) throw new StorageConfigError();

  if (!cachedClient) {
    cachedClient = {
      bucket: config.bucket,
      client: new S3Client({
        // "auto" remains correct for R2 regardless of jurisdiction — R2
        // ignores the region value and routes purely off the endpoint
        // hostname (see the jurisdiction doc link above).
        region: "auto",
        endpoint: buildR2Endpoint(config.accountId, config.jurisdiction),
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      }),
    };
  }
  return cachedClient;
}

/** Random, non-guessable storage key — never derived from the original
 * filename (docs/platform-discovery/26 §13: "random/non-guessable storage
 * keys", "path traversal" — there is no user input in this path at all). */
export function generateStorageKey(extension: string): string {
  const safeExt = /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : "";
  return `files/${randomUUID()}${safeExt}`;
}

export async function uploadObject(input: { storageKey: string; body: Buffer; mimeType: string }): Promise<void> {
  const { client, bucket } = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: input.storageKey,
      Body: input.body,
      ContentType: input.mimeType,
    }),
  );
}

export async function deleteObject(storageKey: string): Promise<void> {
  const { client, bucket } = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
}

/** Short-lived, server-generated signed URL — the only way a file is ever
 * downloaded (docs/platform-discovery/26 §10: no public bucket, no
 * permanent public URL stored or reused). Content-Disposition is set here,
 * not left to the client, so a non-inline-safe type (e.g. an Office doc)
 * can never be tricked into rendering inline in the browser. */
export async function getSignedDownloadUrl(input: {
  storageKey: string;
  downloadFilename: string;
  inline: boolean;
}): Promise<string> {
  const { client, bucket } = getClient();
  const disposition = `${input.inline ? "inline" : "attachment"}; filename="${input.downloadFilename.replace(/"/g, "")}"`;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: input.storageKey,
    ResponseContentDisposition: disposition,
  });

  return getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS });
}

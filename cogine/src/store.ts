import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWrite, sha256, stableStringify } from "./integrity.js";

export type StoredObject = { body: string; etag: string; contentType: string; cacheControl: string };
export type Condition = { ifMatch: string } | { ifNoneMatch: "*" };
export type Metadata = Pick<StoredObject, "contentType" | "cacheControl">;
export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: string, metadata: Metadata, condition: Condition): Promise<void>;
}
export class PreconditionFailed extends Error {}
function checkedKey(key: string): string {
  if (!/^v1\/(?:manifest\.json|revisions\/[a-f0-9]{64}\/catalog\.json)$/.test(key)) throw new Error("Invalid object key");
  return key;
}
function checkCondition(current: StoredObject | null, condition: Condition) {
  if ("ifNoneMatch" in condition ? current !== null : current?.etag !== condition.ifMatch) throw new PreconditionFailed("Conditional write rejected");
}
export class MemoryStore implements ObjectStore {
  objects = new Map<string, StoredObject>();
  writes: { key: string; condition: Condition }[] = [];
  async get(key: string) { return this.objects.get(checkedKey(key)) ?? null; }
  async put(key: string, body: string, metadata: Metadata, condition: Condition) {
    checkedKey(key);
    checkCondition(this.objects.get(key) ?? null, condition);
    this.objects.set(key, { body, etag: `"${sha256(body)}"`, ...metadata });
    this.writes.push({ key, condition });
  }
}
// Durable dry-run store. One record contains bytes and HTTP metadata, swapped together.
// A per-store mkdir lock makes read/compare/replace a real local conditional operation.
export class DirectoryStore implements ObjectStore {
  root: string;
  constructor(root: string) { this.root = resolve(root); }
  async get(key: string): Promise<StoredObject | null> {
    try { return JSON.parse(await readFile(join(this.root, checkedKey(key) + ".object.json"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async put(key: string, body: string, metadata: Metadata, condition: Condition) {
    checkedKey(key);
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, ".write-lock");
    try { await mkdir(lock); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new PreconditionFailed("Dry-run writer busy; retry after rereading"); throw e; }
    try {
      checkCondition(await this.get(key), condition);
      await atomicWrite(join(this.root, key + ".object.json"), stableStringify({ body, etag: `"${sha256(body)}"`, ...metadata }));
    } finally { await rm(lock, { recursive: true }); }
  }
}
export class R2Store implements ObjectStore {
  constructor(private client: S3Client, private bucket: string) {}
  async get(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: checkedKey(key) }));
      if (!result.Body || !result.ETag) throw new Error("R2 response missing body/ETag");
      return { body: await result.Body.transformToString(), etag: result.ETag, contentType: result.ContentType ?? "", cacheControl: result.CacheControl ?? "" };
    } catch (e) { if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  async put(key: string, body: string, metadata: Metadata, condition: Condition) {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: checkedKey(key), Body: body, ContentType: metadata.contentType, CacheControl: metadata.cacheControl, ...("ifMatch" in condition ? { IfMatch: condition.ifMatch } : { IfNoneMatch: "*" }) }));
    } catch (e) {
      const code = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (code === 409 || code === 412) throw new PreconditionFailed("R2 conditional write rejected");
      throw e;
    }
  }
}
export function configuredR2Store(env: NodeJS.ProcessEnv = process.env): { store: R2Store; publicBaseUrl: string } {
  if (env.MODELSPAGE_PUBLISH_ENABLED !== "true") throw new Error("Production publishing is disabled; set MODELSPAGE_PUBLISH_ENABLED=true only in the protected environment");
  const required = ["MODELSPAGE_PUBLIC_BASE_URL", "MODELSPAGE_R2_ACCOUNT_ID", "MODELSPAGE_R2_BUCKET", "MODELSPAGE_R2_ACCESS_KEY_ID", "MODELSPAGE_R2_SECRET_ACCESS_KEY"] as const;
  if (required.some(key => !env[key])) throw new Error("Missing required production configuration (see .env.example)");
  const url = new URL(env.MODELSPAGE_PUBLIC_BASE_URL!);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || /(?:^|\.)r2\.dev$/.test(url.hostname) || url.hostname.endsWith("r2.cloudflarestorage.com")) throw new Error("Production PUBLIC_BASE_URL must be an HTTPS custom domain origin");
  const account = env.MODELSPAGE_R2_ACCOUNT_ID!;
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("Invalid R2 account ID");
  return { store: new R2Store(new S3Client({ region: "auto", endpoint: `https://${account}.r2.cloudflarestorage.com`, credentials: { accessKeyId: env.MODELSPAGE_R2_ACCESS_KEY_ID!, secretAccessKey: env.MODELSPAGE_R2_SECRET_ACCESS_KEY! }, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" }), env.MODELSPAGE_R2_BUCKET!), publicBaseUrl: url.origin };
}

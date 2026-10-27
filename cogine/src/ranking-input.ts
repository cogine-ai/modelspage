import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { atomicWrite, sha256, stableStringify } from "./integrity.js";
import { observedPopularityPolicySchema, type ObservedPopularityPolicy } from "./observed-popularity.js";
import { validCalendarDate } from "./schema.js";
import { validateRankSourceCatalog, validateRankSourceSnapshot } from "./adapters/rank-sources.js";

export const RANKING_INPUT_FORMAT = "modelspage-ranking-input/aes-256-gcm/v1";
export type RankingInput = { schema_version: 1; evaluation_date: string; policy: ObservedPopularityPolicy; snapshots: Record<string, any>[]; catalogs: Record<string, any>[] };
const inputSchema = z.object({ schema_version: z.literal(1), evaluation_date: z.string().refine(date => validCalendarDate(date, "day")), policy: observedPopularityPolicySchema, snapshots: z.array(z.record(z.unknown())), catalogs: z.array(z.record(z.unknown())) }).strict();
const reviewSchema = z.object({ evaluation_date: z.string(), policy_id: z.string(), sources: z.array(z.object({ id: z.string(), status: z.string(), entries: z.number().int().nonnegative(), complete: z.boolean(), retrieved_at: z.string().nullable(), data_as_of: z.string().nullable(), collection: z.string(), redistribution: z.string() }).strict()) }).strict();
const envelopeSchema = z.object({ format: z.literal(RANKING_INPUT_FORMAT), plaintext_sha256: z.string().regex(/^[a-f0-9]{64}$/), nonce: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/), tag: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/), ciphertext: z.string().min(1).max(48_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/), review: reviewSchema }).strict();
export type RankingEnvelope = z.infer<typeof envelopeSchema>;
function encryptionKey(value: string | undefined): Buffer {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error("MODELSPAGE_INPUT_ENCRYPTION_KEY must be a project-only 32-byte hex key");
  return Buffer.from(value, "hex");
}
export function validateRankingInput(input: unknown): RankingInput {
  const parsed = inputSchema.parse(input) as RankingInput;
  if (parsed.policy.weights_status !== "accepted") throw new Error("Daily ranking inputs require accepted global weights");
  if (new Set(parsed.snapshots.map(source => source.source_id)).size !== parsed.snapshots.length) throw new Error("Ranking input has duplicate source snapshots");
  for (const snapshot of parsed.snapshots) validateRankSourceSnapshot(snapshot);
  for (const catalog of parsed.catalogs) validateRankSourceCatalog(catalog);
  return parsed;
}
export function rankingInputReview(input: RankingInput): RankingEnvelope["review"] {
  return { evaluation_date: input.evaluation_date, policy_id: input.policy.id, sources: input.snapshots.map(source => ({ id: source.source_id, status: source.status, entries: source.entries?.length ?? 0, complete: source.complete_response === true, retrieved_at: source.retrieved_at ?? null, data_as_of: source.data_as_of ?? null, collection: source.usage?.collection ?? "unverified", redistribution: source.usage?.redistribution ?? "unverified" })).sort((a, b) => a.id.localeCompare(b.id, "en")) };
}
/** Public review packet contains only authenticated ciphertext and bounded metadata. */
export function inspectRankingEnvelope(input: unknown): RankingEnvelope {
  const envelope = envelopeSchema.parse(input);
  if (Buffer.from(envelope.nonce, "base64").length !== 12 || Buffer.from(envelope.tag, "base64").length !== 16) throw new Error("Invalid ranking envelope nonce/tag");
  return envelope;
}
export function openRankingInput(input: unknown, key = process.env.MODELSPAGE_INPUT_ENCRYPTION_KEY): RankingInput {
  const envelope = inspectRankingEnvelope(input);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(key), Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(RANKING_INPUT_FORMAT + ":" + envelope.plaintext_sha256));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  let plaintext: Buffer;
  try { plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]); }
  catch { throw new Error("Ranking input authentication failed; keep the previous reviewed input"); }
  if (sha256(plaintext) !== envelope.plaintext_sha256) throw new Error("Ranking input content hash mismatch");
  const result = validateRankingInput(JSON.parse(plaintext.toString("utf8")));
  if (stableStringify(rankingInputReview(result)) !== stableStringify(envelope.review)) throw new Error("Ranking input review metadata does not match its authenticated content");
  return result;
}
export function sealRankingInput(input: RankingInput, key = process.env.MODELSPAGE_INPUT_ENCRYPTION_KEY, previous?: unknown): RankingEnvelope {
  const checked = validateRankingInput(input), plaintext = stableStringify(checked), hash = sha256(plaintext);
  if (previous) {
    const old = inspectRankingEnvelope(previous);
    // Authenticate the retained object; equal metadata alone must not preserve corrupt bytes.
    if (old.plaintext_sha256 === hash) { openRankingInput(old, key); return old; }
  }
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(key), nonce);
  cipher.setAAD(Buffer.from(RANKING_INPUT_FORMAT + ":" + hash));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = { format: RANKING_INPUT_FORMAT, plaintext_sha256: hash, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"), review: rankingInputReview(checked) };
  openRankingInput(envelope, key);
  return inspectRankingEnvelope(envelope);
}
export async function writeRankingInput(path: string, input: RankingInput, key = process.env.MODELSPAGE_INPUT_ENCRYPTION_KEY): Promise<{ envelope: RankingEnvelope; changed: boolean }> {
  const previous = await Bun.file(path).exists() ? await Bun.file(path).json() : undefined;
  const envelope = sealRankingInput(input, key, previous), body = stableStringify(envelope);
  const changed = !previous || stableStringify(previous) !== body;
  if (changed) await atomicWrite(path, body);
  return { envelope, changed };
}

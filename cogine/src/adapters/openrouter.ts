import { z } from "zod";
import type { SourceRevision, Usage } from "../types.js";
import { requestJson } from "../request.js";
import { sha256, stableStringify } from "../integrity.js";
import { sourceRevisionSchema } from "../schema.js";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models?sort=top-weekly&output_modalities=all&limit=1000&offset=0";
export const OPENROUTER_DOC = "https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties";
export const OpenRouterConfig = z.object({
  enabled: z.boolean(),
  endpoint: z.string().url(),
  usage: z.object({ collection: z.enum(["allowed", "unverified", "disabled"]), redistribution: z.enum(["allowed", "unverified", "disabled"]), evidence: z.string().min(1) }).strict(),
  // A review may identify covered entries. Empty means no item has verified usage coverage.
  ranked_ids: z.array(z.string().min(1)),
  ranking_evidence: z.string(),
}).strict();
export type OpenRouterConfiguration = z.infer<typeof OpenRouterConfig>;
const Page = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough()),
  total_count: z.number().int().nonnegative(),
  links: z.object({ next: z.string().nullable() }).passthrough(),
}).passthrough();
export type PopularityEntry = { source_model_id: string; position: number; ranking_eligible: boolean };
export type OpenRouterSnapshot = { source: SourceRevision; attempted_at: string; entries: PopularityEntry[]; etag?: string; pagination: { pages: number; total: number | null; received: number; ended: boolean }; retained_last_good: boolean };
const snapshotSchema = z.object({ source: sourceRevisionSchema, attempted_at: z.string().datetime({ offset: true }), entries: z.array(z.object({ source_model_id: z.string().min(1), position: z.number().int().positive(), ranking_eligible: z.boolean() }).strict()), etag: z.string().optional(), pagination: z.object({ pages: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable(), received: z.number().int().nonnegative(), ended: z.boolean() }).strict(), retained_last_good: z.boolean() }).strict();
export function validateOpenRouterSnapshot(input: unknown): OpenRouterSnapshot {
  const snapshot = snapshotSchema.parse(input) as OpenRouterSnapshot;
  if (snapshot.source.id !== "openrouter-weekly") throw new Error("Snapshot has wrong source identity");
  if (new Set(snapshot.entries.map((entry) => entry.source_model_id)).size !== snapshot.entries.length || snapshot.entries.some((entry, index) => entry.position !== index + 1)) throw new Error("Snapshot identities/positions are not unique, ordered and contiguous");
  if (["success", "not_modified"].includes(snapshot.source.status) && (!snapshot.source.complete || !snapshot.pagination.ended || snapshot.pagination.total !== snapshot.entries.length || snapshot.pagination.received !== snapshot.entries.length || snapshot.entries.length === 0)) throw new Error("Successful snapshot is incomplete");
  return snapshot;
}
export class PartialRankingError extends Error { constructor(message: string) { super(message); this.name = "PartialRankingError"; } }

export function parseOpenRouterPages(pages: unknown[], configuration: OpenRouterConfiguration): { entries: PopularityEntry[]; total: number } {
  const parsed = pages.map((page) => Page.parse(page));
  if (!parsed.length) throw new PartialRankingError("No pages received");
  const total = parsed[0]!.total_count;
  const ids = new Set<string>();
  const entries: PopularityEntry[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const page = parsed[i]!;
    if (page.total_count !== total) throw new PartialRankingError("Total changed during pagination");
    if (i < parsed.length - 1 && page.links.next === null) throw new PartialRankingError("Pages continue after terminal page");
    for (const model of page.data) {
      if (ids.has(model.id)) throw new PartialRankingError("Duplicate identity during pagination");
      ids.add(model.id);
      entries.push({ source_model_id: model.id, position: entries.length + 1, ranking_eligible: configuration.ranking_evidence.length > 0 && configuration.ranked_ids.includes(model.id) });
    }
  }
  if (parsed.at(-1)!.links.next !== null || entries.length !== total) throw new PartialRankingError(`Incomplete ranking: ${entries.length}/${total}`);
  // A complete empty catalog is treated as an anomaly requiring review, not mass deletion.
  if (total === 0) throw new PartialRankingError("Empty public catalog requires manual review");
  return { entries, total };
}

function baseSource(configuration: OpenRouterConfiguration): SourceRevision {
  return { id: "openrouter-weekly", status: "disabled", url: configuration.endpoint, retrieved_at: null, data_as_of: null, window: { start: null, end: null }, usage: configuration.usage as Usage, complete: false };
}

export async function fetchOpenRouter(configuration: OpenRouterConfiguration, options: { now: string; previous?: OpenRouterSnapshot; probe?: boolean; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<OpenRouterSnapshot> {
  const source = baseSource(configuration);
  const empty: OpenRouterSnapshot = { source, attempted_at: options.now, entries: [], pagination: { pages: 0, total: null, received: 0, ended: false }, retained_last_good: false };
  if (!options.probe && (!configuration.enabled || configuration.usage.collection !== "allowed")) return { ...empty, entries: options.previous?.entries ?? [], retained_last_good: !!options.previous?.entries.length, source: { ...source, retrieved_at: options.previous?.source.retrieved_at ?? null, sha256: options.previous?.source.sha256 } };
  const initial = new URL(configuration.endpoint);
  if (initial.origin !== "https://openrouter.ai" || initial.pathname !== "/api/v1/models" || !["most-popular", "top-weekly"].includes(initial.searchParams.get("sort") ?? "") || initial.searchParams.get("output_modalities") !== "all") throw new Error("OpenRouter collector only accepts the reviewed public all-models weekly endpoint");
  const pages: unknown[] = [];
  const hashes: string[] = [];
  let next: string | null = initial.href;
  const visited = new Set<string>();
  let etag: string | undefined;
  try {
    while (next) {
      if (pages.length >= 100 || visited.has(next)) throw new PartialRankingError("Pagination loop or page limit exceeded");
      visited.add(next);
      const result = await requestJson(next, { fetcher: options.fetcher, sleep: options.sleep, etag: pages.length === 0 && options.previous?.pagination.pages === 1 ? options.previous.etag : undefined });
      if (result.status === "not_modified") {
        if (!options.previous || pages.length) throw new Error("304 without a complete cached snapshot");
        return { ...options.previous, attempted_at: options.now, source: { ...options.previous.source, status: "not_modified", usage: configuration.usage }, retained_last_good: true };
      }
      pages.push(result.body);
      hashes.push(result.sha256);
      if (pages.length === 1) etag = result.etag;
      const page = Page.parse(result.body);
      next = page.links.next;
      if (next !== null) {
        const url = new URL(next, initial);
        if (url.origin !== initial.origin || url.pathname !== initial.pathname || url.searchParams.get("sort") !== initial.searchParams.get("sort") || url.searchParams.get("output_modalities") !== "all") throw new PartialRankingError("Pagination link changed origin, endpoint, sort or scope");
        next = url.href;
        await (options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(250);
      }
    }
    const result = parseOpenRouterPages(pages, configuration);
    const digest = hashes.length === 1 ? hashes[0]! : sha256(stableStringify(hashes));
    // Public input consists of exact IDs, order and reviewed item coverage. Unused response
    // fields or JSON formatting do not manufacture new source freshness or data proposals.
    const unchanged = options.previous !== undefined && stableStringify(options.previous.entries) === stableStringify(result.entries);
    if (unchanged) return { ...options.previous!, source: { ...options.previous!.source, status: "not_modified", usage: configuration.usage }, attempted_at: options.now, retained_last_good: true };
    return { source: { ...source, status: "success", retrieved_at: options.now, sha256: digest, complete: true }, attempted_at: options.now, entries: result.entries, etag, pagination: { pages: pages.length, total: result.total, received: result.entries.length, ended: true }, retained_last_good: false };
  } catch (error) {
    const partial = error instanceof PartialRankingError || (pages.length > 0 && error instanceof z.ZodError);
    const previous = options.previous;
    return { ...empty, entries: previous?.entries ?? [], etag: previous?.etag, retained_last_good: !!previous?.entries.length, pagination: { pages: pages.length, total: null, received: pages.reduce<number>((count, page) => count + (Page.safeParse(page).success ? (page as z.infer<typeof Page>).data.length : 0), 0), ended: false }, source: { ...source, status: partial ? "partial" : "failed", retrieved_at: previous?.source.retrieved_at ?? null, sha256: previous?.source.sha256, complete: previous?.source.complete ?? false, error: `${error instanceof Error ? error.message : "Source request failed"} (attempted ${options.now})` } };
  }
}

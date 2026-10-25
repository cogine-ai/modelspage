import { sha256 } from "./integrity.js";

export type JsonResponse = { status: "success"; body: unknown; sha256: string; etag?: string } | { status: "not_modified"; etag?: string };
export type RequestOptions = { etag?: string; fetcher?: typeof fetch; attempts?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };

// Shared request governance. Source semantics and pagination stay in adapters.
export async function requestJson(url: string, options: RequestOptions = {}): Promise<JsonResponse> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await (options.fetcher ?? fetch)(url, {
        headers: { accept: "application/json", ...(options.etag ? { "if-none-match": options.etag } : {}) },
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        redirect: "error",
      });
      const etag = response.headers.get("etag") ?? undefined;
      if (response.status === 304) return { status: "not_modified", etag };
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 500 * 2 ** attempt);
          continue;
        }
        throw new Error(`HTTP ${response.status} from ${new URL(url).origin}`);
      }
      if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Expected application/json response");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 32 * 1024 * 1024) throw new Error("Source response exceeds 32 MiB limit");
      return { status: "success", body: JSON.parse(new TextDecoder().decode(bytes)), sha256: sha256(bytes), etag };
    } catch (error) {
      if (attempt + 1 >= attempts || !(error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError"))) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error("Request attempts exhausted");
}

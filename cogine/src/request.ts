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

export type PublicReadEvent = {
  url: string;
  phase: "headers" | "body";
  attempt: number;
  attempts: number;
  elapsed_ms: number;
  outcome: "success" | "retry" | "failed";
  status?: number;
  error_name?: string;
  error_code?: string;
  retry_after_ms?: number;
};
export type PublicReadOptions = Pick<RequestOptions, "fetcher" | "attempts" | "timeoutMs" | "sleep"> & {
  allowNotFound?: boolean;
  onEvent?: (event: PublicReadEvent) => void;
};

class PublicHttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); this.name = "HttpError"; }
}

function publicErrorDetails(error: unknown) {
  const token = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;
  const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  return { error_name: token(value?.name) ?? "Error", error_code: token(value?.code) ?? token(value?.cause?.code) };
}

function publicRetryDelay(response: Response | undefined, attempt: number) {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter?.trim()) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 30_000);
  }
  return Math.min(500 * 2 ** (attempt - 1), 30_000);
}

/** Transport only: callers validate the complete bytes before trusting or publishing them. */
export async function readPublicBytes(url: string | URL, options: PublicReadOptions = {}): Promise<{ response: Response; bytes: Uint8Array }> {
  const parsed = new URL(url), safeUrl = parsed.origin + parsed.pathname;
  const attempts = options.attempts ?? 3, timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Public reads require positive integer attempts and timeoutMs");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = performance.now(), controller = new AbortController();
    let phase: PublicReadEvent["phase"] = "headers", response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectTimeout: (reason: unknown) => void;
    const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      const error = new DOMException("Public read deadline exceeded", "TimeoutError");
      controller.abort(error);
      rejectTimeout(error);
    }, timeoutMs);
    const event = () => ({ url: safeUrl, phase, attempt, attempts, elapsed_ms: Math.round(performance.now() - started), ...(response ? { status: response.status } : {}) });
    let bytes: Uint8Array;
    try {
      bytes = await Promise.race([deadline, (async () => {
        response = await (options.fetcher ?? fetch)(url, { headers: { "Cache-Control": "no-cache" }, signal: controller.signal });
        if (!response.ok && !(options.allowNotFound && response.status === 404)) throw new PublicHttpError(response.status);
        phase = "body";
        if (!response.body) return new Uint8Array();
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value); length += chunk.value.length;
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        return body;
      })()]);
    } catch (error) {
      // Cancel before another attempt, including a reader blocked during a body timeout.
      void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
      const details = publicErrorDetails(error);
      const transient = error instanceof PublicHttpError ? [408, 429].includes(error.status) || error.status >= 500 && error.status <= 599
        : ["TypeError", "TimeoutError", "AbortError"].includes(details.error_name)
          || /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|ConnectionClosed|SocketClosed)$/.test(details.error_code ?? "");
      const retry = transient && attempt < attempts;
      const failure: PublicReadEvent = { ...event(), ...details, outcome: retry ? "retry" : "failed", ...(retry ? { retry_after_ms: publicRetryDelay(response, attempt) } : {}) };
      clearTimeout(timer);
      options.onEvent?.(failure);
      if (!retry) {
        const status = error instanceof PublicHttpError ? ` HTTP ${error.status}` : "";
        throw new Error(`Public read failed: url=${safeUrl} phase=${phase} attempt=${attempt}/${attempts} elapsed_ms=${failure.elapsed_ms} error=${details.error_name}${details.error_code ? ` code=${details.error_code}` : ""}${status}`);
      }
      await sleep(failure.retry_after_ms!);
      continue;
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
    }
    options.onEvent?.({ ...event(), outcome: "success" });
    return { response: response!, bytes };
  }
  throw new Error("Public read attempts exhausted");
}

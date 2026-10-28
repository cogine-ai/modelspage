import { describe, expect, test } from "bun:test";
import { readPublicBytes, type PublicReadEvent } from "../src/request.js";

const url = "https://models.example/v1/manifest.json";
const noWait = async () => {};
const fetcher = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => handler as typeof fetch;

describe("public release reads", () => {
  test("recovers from a connection reset before response headers", async () => {
    let calls = 0;
    const events: PublicReadEvent[] = [];
    const result = await readPublicBytes(url, {
      fetcher: fetcher(async (_input, init) => {
        expect(new Headers(init?.headers).get("cache-control")).toBe("no-cache");
        if (++calls === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        return new Response("verified later by the caller");
      }),
      sleep: noWait,
      onEvent: event => events.push(event),
    });
    expect(calls).toBe(2);
    expect(new TextDecoder().decode(result.bytes)).toBe("verified later by the caller");
    expect(events[0]).toMatchObject({ phase: "headers", outcome: "retry", error_code: "ECONNRESET" });
  });

  test("retries a 200 response whose body fails with TimeoutError", async () => {
    let calls = 0;
    const events: PublicReadEvent[] = [];
    const result = await readPublicBytes(url, {
      fetcher: fetcher(async () => ++calls === 1
        ? new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("body stalled", "TimeoutError")); } }))
        : new Response("complete")),
      sleep: noWait,
      onEvent: event => events.push(event),
    });
    expect(calls).toBe(2);
    expect(new TextDecoder().decode(result.bytes)).toBe("complete");
    expect(events[0]).toMatchObject({ phase: "body", status: 200, outcome: "retry", error_name: "TimeoutError" });
  });

  test("the attempt deadline includes a stalled body and cancels it before retry", async () => {
    let calls = 0, cancelled = false;
    const events: PublicReadEvent[] = [];
    const result = await readPublicBytes(url, {
      timeoutMs: 10,
      fetcher: fetcher(async () => {
        if (++calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
        expect(cancelled).toBe(true);
        return new Response("recovered");
      }),
      sleep: noWait,
      onEvent: event => events.push(event),
    });
    expect(new TextDecoder().decode(result.bytes)).toBe("recovered");
    expect(events[0]).toMatchObject({ phase: "body", outcome: "retry", error_name: "TimeoutError" });
  });

  test("exhausted attempts explain the stage and retain safe error codes without leaking request secrets", async () => {
    const events: PublicReadEvent[] = [];
    const sensitiveUrl = "https://user:password@models.example/v1/manifest.json?token=private-query#private-fragment";
    let failure: Error | undefined;
    try {
      await readPublicBytes(sensitiveUrl, {
        fetcher: fetcher(async () => { throw Object.assign(new TypeError(`failed ${sensitiveUrl}`), { cause: { code: "ECONNRESET" } }); }),
        sleep: noWait,
        onEvent: event => events.push(event),
      });
    } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain("https://models.example/v1/manifest.json");
    expect(failure?.message).toContain("phase=headers");
    expect(failure?.message).toContain("attempt=3/3");
    expect(failure?.message).toContain("TypeError");
    expect(failure?.message).toContain("ECONNRESET");
    expect(failure?.message).toMatch(/elapsed_ms=\d+/);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ outcome: "failed", attempt: 3, error_name: "TypeError", error_code: "ECONNRESET" });
    const diagnostics = JSON.stringify({ message: failure?.message, events });
    for (const secret of ["user", "password", "private-query", "private-fragment", "?token"]) expect(diagnostics).not.toContain(secret);
  });

  test("final body failure is reported as body failure rather than successful HTTP", async () => {
    await expect(readPublicBytes(url, {
      attempts: 2,
      fetcher: fetcher(async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("stalled", "TimeoutError")); } }))),
      sleep: noWait,
    })).rejects.toThrow(/phase=body.*attempt=2\/2/);
  });

  test("authentication failures and unexpected 404 are terminal and discard response bodies", async () => {
    for (const status of [401, 403, 404]) {
      let calls = 0, cancelled = false;
      await expect(readPublicBytes(url, {
        fetcher: fetcher(async () => {
          calls++;
          return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
        }),
        sleep: noWait,
      })).rejects.toThrow(`HTTP ${status}`);
      expect(calls).toBe(1);
      expect(cancelled).toBe(true);
    }
  });

  test("an explicitly permitted missing manifest returns its status and raw bytes", async () => {
    const result = await readPublicBytes(url, {
      allowNotFound: true,
      fetcher: fetcher(async () => new Response("missing", { status: 404 })),
    });
    expect(result.response.status).toBe(404);
    expect(new TextDecoder().decode(result.bytes)).toBe("missing");
  });

  test("408, 429 and server failures retry after cancelling the failed body, with capped Retry-After", async () => {
    let calls = 0, cancellations = 0;
    const pauses: number[] = [];
    const statuses = [408, 429, 503];
    const result = await readPublicBytes(url, {
      attempts: 4,
      fetcher: fetcher(async () => {
        expect(cancellations).toBe(calls);
        const status = statuses[calls++];
        return status ? new Response(new ReadableStream({ cancel() { cancellations++; } }), { status, headers: { "retry-after": "9999" } }) : new Response("available");
      }),
      sleep: async ms => { pauses.push(ms); },
    });
    expect(result.response.ok).toBe(true);
    expect(calls).toBe(4);
    expect(pauses).toEqual([30_000, 30_000, 30_000]);
  });

  test("leaves content validation to the caller and accepts catalog bodies larger than 32 MiB", async () => {
    const body = new Uint8Array(33 * 1024 * 1024);
    body[0] = 65; body[body.length - 1] = 90;
    let calls = 0;
    const result = await readPublicBytes("https://models.example/v1/revisions/example/catalog.json", {
      fetcher: fetcher(async () => { calls++; return new Response(body, { headers: { "content-type": "application/octet-stream" } }); }),
    });
    expect(calls).toBe(1);
    expect(result.bytes.length).toBe(body.length);
    expect(result.bytes[0]).toBe(65);
    expect(result.bytes[result.bytes.length - 1]).toBe(90);
  });
});

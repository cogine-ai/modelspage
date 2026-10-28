import { Resolver, lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const hosts = ["models.cogine.ai", "models.cogine.app", "models.cogineai.com"];
const manifestPath = "/v1/manifest.json";
const allowedHeaders = ["content-type", "content-length", "content-encoding", "cf-ray", "server", "etag", "cache-control", "location"];
type Descriptor = { path: string; size: number; sha256: string };
type Probe = Record<string, unknown>;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const errorInfo = (error: unknown) => {
  const e = error as Error & { code?: string; cause?: { code?: string; message?: string } };
  return { name: e?.name ?? "Error", message: String(e?.message ?? error).slice(0, 700), code: e?.code, cause_code: e?.cause?.code, cause_message: e?.cause?.message?.slice(0, 500) };
};
function descriptor(value: unknown): Descriptor {
  const m = value as { revision?: string; objects?: { catalog?: Descriptor } };
  const d = m?.objects?.catalog;
  if (!/^[a-f0-9]{64}$/.test(m?.revision ?? "") || d?.path !== `v1/revisions/${m.revision}/catalog.json` || !/^[a-f0-9]{64}$/.test(d.sha256) || !Number.isSafeInteger(d.size) || d.size <= 0 || d.size > 100_000_000) throw new Error("Unexpected public manifest descriptor");
  return d;
}
function headers(value: Headers) { return Object.fromEntries(allowedHeaders.filter(key => value.has(key)).map(key => [key, value.get(key)])); }
async function pool<T>(items: readonly T[], count: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => { while (queue.length) await work(queue.shift()!); }));
}
async function boundedDns<T>(request: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS lookup exceeded 6 seconds")), 6000); })]);
  } finally { clearTimeout(timer); }
}

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { "out-dir": { type: "string" }, rounds: { type: "string", default: "2" } } });
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("--rounds must be 1, 2 or 3");
  const outDir = resolve(values["out-dir"] ?? ".modelspage/network-diagnostic");
  await mkdir(outDir, { recursive: true });
  const curlVersionProcess = Bun.spawn(["curl", "--version"], { stdout: "pipe", stderr: "pipe" });
  const curlVersion = (await new Response(curlVersionProcess.stdout).text()).split("\n")[0];
  if (await curlVersionProcess.exited) throw new Error("curl is required for network diagnostics");
  const started = Date.now(), deadline = started + 270_000;
  const probes: Probe[] = [], dns: Probe[] = [];
  const manifests = new Map<string, Descriptor>();
  const addresses = new Map<string, string[]>();
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  for (const host of hosts) {
    const results = await Promise.allSettled([boundedDns(resolver.resolve4(host, { ttl: true })), boundedDns(resolver.resolve6(host, { ttl: true })), boundedDns(resolver.resolveCname(host)), boundedDns(lookup(host, { all: true, verbatim: true }))]);
    const entry: Probe = { host };
    for (const [i, key] of ["a", "aaaa", "cname", "lookup"].entries()) {
      const result = results[i]!;
      entry[key] = result.status === "fulfilled" ? result.value : { error: errorInfo(result.reason) };
    }
    if (results[0]!.status === "fulfilled") addresses.set(host, (results[0].value as { address: string }[]).map(item => item.address));
    dns.push(entry);
  }

  async function curlProbe(host: string, path: string, label: string, options: { family?: "auto" | "4" | "6"; ip?: string; encoding?: "gzip" | "identity"; expected?: Descriptor } = {}) {
    const result: Probe = { client: "curl", host, path, label, family: options.family ?? "auto", encoding_request: options.encoding ?? "default", forced_ip: options.ip };
    probes.push(result);
    if (Date.now() >= deadline) { result.skipped = "overall diagnostic budget"; return; }
    const prefix = join(outDir, `.curl-${randomUUID()}`), headerFile = `${prefix}.headers`, bodyFile = `${prefix}.body`;
    const metricKeys = ["http_code", "remote_ip", "http_version", "ssl_verify_result", "time_namelookup", "time_connect", "time_appconnect", "time_starttransfer", "time_total", "size_download"];
    const metrics = `{${metricKeys.map(key => `"${key}":"%{${key}}"`).join(",")}}`;
    const args = ["curl", "--silent", "--show-error", "--connect-timeout", "5", "--max-time", options.expected ? "15" : "10", "--dump-header", headerFile, "--output", bodyFile, "--write-out", metrics, "-H", "Cache-Control: no-cache"];
    if (options.family && options.family !== "auto") args.push(`-${options.family}`);
    if (options.ip) args.push("--resolve", `${host}:443:${options.ip}`);
    if (options.encoding === "gzip") args.push("--compressed", "-H", "Accept-Encoding: gzip");
    if (options.encoding === "identity") args.push("-H", "Accept-Encoding: identity");
    args.push(`https://${host}${path}`);
    const start = Date.now();
    try {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      result.exit_code = exit; result.stderr = stderr.slice(0, 700); result.elapsed_ms = Date.now() - start;
      result.metrics = JSON.parse(stdout);
      const raw = await Bun.file(headerFile).exists() ? await readFile(headerFile, "utf8") : "";
      const last = raw.split(/\r?\n\r?\n/).filter(block => /^HTTP\//.test(block)).at(-1) ?? "";
      const parsed = new Headers();
      for (const line of last.split(/\r?\n/).slice(1)) { const index = line.indexOf(":"); if (index > 0) parsed.append(line.slice(0, index), line.slice(index + 1).trim()); }
      result.headers = headers(parsed);
      const status = Number((result.metrics as Record<string, string>).http_code);
      result.ok = exit === 0 && status === 200;
      if (result.ok) {
        const bytes = new Uint8Array(await Bun.file(bodyFile).arrayBuffer());
        result.decoded_bytes = bytes.length; result.sha256 = digest(bytes);
        if (options.expected) { result.integrity_ok = bytes.length === options.expected.size && result.sha256 === options.expected.sha256; result.ok = result.integrity_ok; }
        else if (path === manifestPath) {
          try { const d = descriptor(JSON.parse(new TextDecoder().decode(bytes))); result.descriptor = d; if (!manifests.has(host)) manifests.set(host, d); }
          catch (error) { result.ok = false; result.error_stage = "manifest_contract"; result.error = errorInfo(error); }
        }
      }
    } catch (error) { result.ok = false; result.error = errorInfo(error); }
    finally { await Promise.all([rm(headerFile, { force: true }), rm(bodyFile, { force: true })]); }
  }

  async function bunRequest(host: string, path: string, label: string, encoding?: "identity", expected?: Descriptor) {
    const result: Probe = { client: "bun", host, path, label, encoding_request: encoding ?? "default", timeout_ms: 15000 };
    probes.push(result);
    if (Date.now() >= deadline) { result.skipped = "overall diagnostic budget"; return null; }
    const start = Date.now(); let stage = "request_headers";
    try {
      const response = await fetch(`https://${host}${path}`, { redirect: "manual", headers: { "Cache-Control": "no-cache", ...(encoding ? { "Accept-Encoding": encoding } : {}) }, signal: AbortSignal.timeout(15000) });
      result.headers_ms = Date.now() - start; result.status = response.status; result.headers = headers(response.headers);
      stage = "body";
      const bytes = new Uint8Array(await response.arrayBuffer());
      result.body_complete_ms = Date.now() - start; result.decoded_bytes = bytes.length; result.sha256 = digest(bytes);
      result.ok = response.status === 200;
      if (!result.ok) return null;
      stage = expected ? "catalog_integrity" : "manifest_contract";
      if (expected) { result.integrity_ok = bytes.length === expected.size && result.sha256 === expected.sha256; result.ok = result.integrity_ok; return null; }
      const d = descriptor(JSON.parse(new TextDecoder().decode(bytes))); result.descriptor = d; return d;
    } catch (error) { result.ok = false; result.error_stage = stage; result.error = errorInfo(error); return null; }
    finally { result.elapsed_ms = Date.now() - start; }
  }

  for (let round = 1; round <= rounds; round++) {
    await pool(hosts.flatMap(host => ["auto", "4", "6"].map(family => ({ host, family: family as "auto" | "4" | "6" }))), 6,
      item => curlProbe(item.host, manifestPath, `manifest-round-${round}`, { family: item.family }));
    await pool(hosts, 3, async host => {
      const d = await bunRequest(host, manifestPath, `manifest-round-${round}`);
      if (d) await bunRequest(host, `/${d.path}`, `catalog-round-${round}`, undefined, d);
    });
  }
  const pairs = [["models.cogine.ai", "models.cogine.app"], ["models.cogine.app", "models.cogine.ai"]] as const;
  await pool(pairs, 2, async ([host, addressHost]) => {
    for (const ip of (addresses.get(addressHost) ?? []).slice(0, 2)) await curlProbe(host, manifestPath, `cross-resolve-from-${addressHost}`, { family: "4", ip });
  });
  await pool(hosts.slice(0, 2), 2, async host => {
    const d = manifests.get(host);
    if (!d) return;
    await bunRequest(host, `/${d.path}`, "catalog-identity-control", "identity", d);
    for (const encoding of ["gzip", "identity"] as const) await curlProbe(host, `/${d.path}`, `catalog-${encoding}-control`, { encoding, expected: d });
  });
  const summary = { probes: probes.length, succeeded: probes.filter(p => p.ok === true).length, failed: probes.filter(p => p.ok === false).length, skipped: probes.filter(p => p.skipped).length };
  resolver.cancel();
  const report = { observed_at: new Date(started).toISOString(), completed_at: new Date().toISOString(), elapsed_ms: Date.now() - started, runtime: { bun: Bun.version, curl: curlVersion, platform: process.platform, arch: process.arch }, hosts, rounds, dns, summary, probes };
  const target = join(outDir, "report.json"), temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2)); await rename(temporary, target);
  console.log(JSON.stringify({ ...summary, elapsed_ms: report.elapsed_ms, report: target }));
}

if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ diagnostic_error: errorInfo(error) })); process.exitCode = 1; });

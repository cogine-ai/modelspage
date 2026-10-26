import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { generateV2 } from "../../../packages/core/src/generate-v2.js";
import { AuthoredModelV2, LabModelV2 } from "../../../packages/core/src/schema-v2.js";
import { atomicWrite, sha256, stableStringify } from "../../src/integrity.js";

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Git reference operation failed: ${args[0]}`);
  return new TextDecoder().decode(result.stdout).trim();
}
function datePrecision(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? "day" : /^\d{4}-\d{2}$/.test(value) ? "month" : /^\d{4}$/.test(value) ? "year" : "unknown";
}
function providerModelId(path: string) {
  const providerId = path.split("/")[1]!;
  return path.slice(`providers/${providerId}/models/`.length, -5);
}
function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) return { message: "Unknown parser failure" };
  const object = error as Error & { issues?: { path?: unknown; message?: unknown }[]; cause?: unknown };
  return { name: object.name, message: object.message, ...(object.issues ? { issues: object.issues.map(issue => ({ path: issue.path, message: issue.message })) } : {}), ...(object.cause ? { cause: object.cause instanceof Error ? describeError(object.cause) : object.cause } : {}) };
}

type IncompatibleFile = { path: string; issues: unknown[] };
export async function generateCompatibleModels(dataDir: string, incompatibleFiles: IncompatibleFile[], workDir = resolve(".modelspage/full-validation")) {
  await mkdir(workDir, { recursive: true });
  const compatibilityView = await mkdtemp(join(workDir, "upstream-compatible-"));
  const copy = Bun.spawnSync(["cp", "-R", join(dataDir, "models"), join(dataDir, "providers"), compatibilityView], { stdout: "pipe", stderr: "pipe" });
  if (copy.exitCode !== 0) throw new Error("Could not prepare isolated compatibility data view");
  const excluded = new Map<string, unknown[]>();
  const problems: unknown[] = [];
  const providerInputs = new Map<string, { base_model?: unknown }>();
  for await (const path of new Bun.Glob("providers/*/models/**/*.toml").scan({ cwd: dataDir, followSymlinks: true })) {
    providerInputs.set(path, Bun.TOML.parse(await Bun.file(join(dataDir, path)).text()));
  }
  const labPaths = await Array.fromAsync(new Bun.Glob("models/**/*.toml").scan({ cwd: dataDir, followSymlinks: true }));
  async function excludeFile(path: string, issues: unknown[]) {
    if (excluded.has(path)) return;
    excluded.set(path, issues);
    if (!incompatibleFiles.some(file => file.path === path)) incompatibleFiles.push({ path, issues });
    await rm(join(compatibilityView, path), { force: true });
  }
  async function excludeLab(path: string, issues: unknown[]) {
    // Follow only original archive aliases. Removing one target from the temporary
    // view must also isolate its lab aliases and explicit provider dependencies.
    const target = await realpath(join(dataDir, path));
    for (const labPath of labPaths) {
      if (await realpath(join(dataDir, labPath)) !== target) continue;
      const labIssues = labPath === path ? issues : [{ message: "Lab alias refers to an isolated incompatible lab", source_file: path }];
      await excludeFile(labPath, labIssues);
      const canonical = labPath.slice("models/".length, -5);
      for (const [providerPath, authored] of providerInputs) {
        if (authored.base_model === canonical) await excludeFile(providerPath, [{ message: "Explicit base_model refers to an isolated incompatible lab; inherited fields remain unresolved", base_model: canonical, source_file: labPath }]);
      }
    }
  }
  for (const file of [...incompatibleFiles]) {
    if (file.path.startsWith("models/")) await excludeLab(file.path, file.issues);
    else if (providerInputs.has(file.path)) await excludeFile(file.path, file.issues);
  }
  let generated: Awaited<ReturnType<typeof generateV2>> = {};
  let generationSucceeded = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    for await (const path of new Bun.Glob("providers/*/provider.toml").scan({ cwd: compatibilityView, followSymlinks: true })) {
      const id = path.split("/")[1]!;
      const modelsDir = join(compatibilityView, "providers", id, "models");
      if (!existsSync(modelsDir)) continue;
      const files = await Array.fromAsync(new Bun.Glob("**/*.toml").scan({ cwd: modelsDir, followSymlinks: true }));
      if (!files.length) await rm(join(compatibilityView, "providers", id), { recursive: true });
    }
    try { generated = await generateV2(join(compatibilityView, "providers")); generationSucceeded = true; break; }
    catch (error) {
      const cause = error instanceof Error ? error.cause as { modelPath?: string } | undefined : undefined;
      const path = cause?.modelPath?.startsWith(compatibilityView + "/") ? cause.modelPath.slice(compatibilityView.length + 1) : null;
      if (!path || excluded.has(path)) { problems.push(describeError(error)); break; }
      const issues = [describeError(error)];
      if (path.startsWith("models/")) await excludeLab(path, issues);
      else if (providerInputs.has(path)) await excludeFile(path, issues);
      else { problems.push(describeError(error)); break; }
    }
  }
  if (!generationSucceeded && !problems.length) problems.push({ message: "Compatibility parsing exhausted its bounded isolation attempts" });
  return { generated, excluded, compatibilityView, generationSucceeded, problems };
}

type DateProjection = { release_date: string; removed_fields: string[]; source_sha256: string; projection_sha256: string };
export async function projectFixedParserDates(dataDir: string, incompatibleFiles: IncompatibleFile[], workDir = resolve(".modelspage/full-validation")) {
  const changes = new Map<string, { body: string; evidence: Omit<DateProjection, "release_date"> }>();
  for (const file of incompatibleFiles) {
    if (!file.path.startsWith("providers/") || !file.issues.length) continue;
    const tools = new Map<string, { path: string[]; keys: Set<string>; removeContainer: boolean }>();
    for (const value of file.issues) {
      const issue = value as { code?: string; path?: unknown[]; keys?: unknown[] };
      const path = issue?.path;
      const length = Array.isArray(path) && path[0] === "capabilities" && path[1] === "tools" ? 2
        : Array.isArray(path) && path[0] === "api" && typeof path[1] === "string" && path[2] === "capabilities" && path[3] === "tools" ? 4 : 0;
      if (!length || !path || path.length < length) { tools.clear(); break; }
      const toolPath = path.slice(0, length) as string[];
      const key = JSON.stringify(toolPath);
      const removal = tools.get(key) ?? { path: toolPath, keys: new Set<string>(), removeContainer: false };
      if (issue.code === "unrecognized_keys" && path.length === length && issue.keys?.length && issue.keys.every(key => typeof key === "string")) {
        for (const key of issue.keys as string[]) removal.keys.add(key);
      } else removal.removeContainer = true;
      tools.set(key, removal);
    }
    const deletions = [...tools.values()].map(removal => removal.removeContainer
      ? { path: removal.path.slice(0, -1), keys: ["tools"] }
      : { path: removal.path, keys: [...removal.keys] });
    if (!deletions.length) continue;
    const original = await Bun.file(join(dataDir, file.path)).text();
    const authored = Bun.TOML.parse(original) as Record<string, any>;
    const projected = structuredClone(authored);
    const removedFields: string[] = [];
    for (const deletion of deletions) {
      let container: any = projected;
      for (const part of deletion.path) container = container?.[part];
      if (!container || typeof container !== "object" || Array.isArray(container)) throw new Error("Diagnosed N projection tools container is missing");
      for (const key of deletion.keys) {
        if (!Object.hasOwn(container, key)) throw new Error("Diagnosed N projection tools key is missing");
        delete container[key]; removedFields.push([...deletion.path, key].join("."));
      }
    }
    const { schema: _schema, ...data } = projected;
    if (!AuthoredModelV2.safeParse({ ...data, id: providerModelId(file.path) }).success) continue;
    // Pinned Bun 1.4.4 provides stringify; the installed Bun types predate it.
    const toml = Bun.TOML as typeof Bun.TOML & { stringify(value: Record<string, unknown>): string };
    const body = toml.stringify(projected);
    if (stableStringify(Bun.TOML.parse(body)) !== stableStringify(projected)) throw new Error("N projection TOML round trip changed authored fields");
    for (const key of ["base_model", "release_date", "base_model_omit", "id", "name", "type"]) {
      if (stableStringify(projected[key]) !== stableStringify(authored[key])) throw new Error("N projection changed an identity/date field");
    }
    changes.set(file.path, { body, evidence: { removed_fields: removedFields, source_sha256: sha256(original), projection_sha256: sha256(body) } });
  }
  const dates = new Map<string, DateProjection>();
  if (!changes.size) return { dates, summary: { eligible_records: 0, projected_records: 0, generation_succeeded: null } };
  await mkdir(workDir, { recursive: true });
  const projectionView = await mkdtemp(join(workDir, "upstream-date-projection-"));
  const copy = Bun.spawnSync(["cp", "-R", join(dataDir, "models"), join(dataDir, "providers"), projectionView], { stdout: "pipe", stderr: "pipe" });
  if (copy.exitCode !== 0) throw new Error("Could not prepare the isolated N projection view");
  for (const [path, change] of changes) {
    // Break a temporary alias before writing so only its diagnosed record changes.
    await rm(join(projectionView, path), { force: true });
    await atomicWrite(join(projectionView, path), change.body);
  }
  const remaining = incompatibleFiles.filter(file => !changes.has(file.path)).map(file => ({ ...file, issues: [...file.issues] }));
  const compatible = await generateCompatibleModels(projectionView, remaining, workDir);
  for (const [path, change] of changes) {
    const providerId = path.split("/")[1]!;
    const model = compatible.generated[providerId]?.models[providerModelId(path)];
    if (model && typeof model.release_date === "string") dates.set(path, { release_date: model.release_date, ...change.evidence });
  }
  return { dates, summary: { eligible_records: changes.size, projected_records: dates.size, generation_succeeded: compatible.generationSucceeded, projection_view: projectionView, parser_view: compatible.compatibilityView, unresolved_records: [...changes.keys()].filter(path => !dates.has(path)), problems: compatible.problems, isolated_files: remaining } };
}

export function referenceReleaseDate(resolved: string | undefined, projected: string | undefined, authored: { release_date?: unknown; base_model_omit?: unknown }) {
  if (resolved !== undefined) return { date: resolved, source: "fixed_generator" };
  if (projected !== undefined) return { date: projected, source: "fixed_generator_n_projection" };
  const omitted = Array.isArray(authored.base_model_omit) && authored.base_model_omit.includes("release_date");
  return !omitted && typeof authored.release_date === "string" ? { date: authored.release_date, source: "explicit_provider_field" } : { date: null, source: null };
}

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { commit: { type: "string" }, "data-dir": { type: "string" }, out: { type: "string" } } });
  const commit = values.commit;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("An immutable --commit SHA is required");
  const dataDir = resolve(values["data-dir"] ?? ".modelspage/full-validation/upstream-latest");
  const outputPath = resolve(values.out ?? ".modelspage/full-validation/inputs/upstream-latest.json");
  const lock = await Bun.file("cogine/upstream.lock.json").json() as { commit: string; repository: string };
  if (git("rev-parse", commit) !== commit) throw new Error("Latest reference object does not resolve exactly");
  if (git("diff", "--name-only", lock.commit, "--", "packages/core")) throw new Error("Trusted parser tree differs from the pinned upstream parser");
  const dataTrees = { models: git("rev-parse", `${commit}:models`), providers: git("rev-parse", `${commit}:providers`) };
  const receiptFile = Bun.file(join(dataDir, "retrieval-receipt.json"));
  const receipt = await receiptFile.exists() ? await receiptFile.json() as { commit?: string; retrieved_at?: string; archive_verified_at?: string; verified_blob_count?: number; blob_mismatches?: number } : null;
  if (receipt && receipt.commit !== commit) throw new Error("Data retrieval receipt identifies a different immutable commit");
  const source = { repository: lock.repository, commit, commit_time: git("show", "-s", "--format=%cI", commit), parser_commit: lock.commit, parser_tree_hash: git("rev-parse", `${lock.commit}:packages/core`), data_tree_hash: sha256(stableStringify(dataTrees)), data_trees: dataTrees, retrieved_at: receipt?.retrieved_at ?? null, parsed_at: new Date().toISOString(), archive_verification: receipt ? { verified_at: receipt.archive_verified_at ?? null, blob_count: receipt.verified_blob_count ?? null, mismatches: receipt.blob_mismatches ?? null } : null, extracted_data_path: dataDir, parser_policy: "Execute only the local pinned packages/core parser; latest archive contains models/providers data only" };
  const problems: unknown[] = [];
  let providers: any[] = [];
  let status: "success" | "schema_incompatible" | "partial" = "success";
  try {
    const generated = await generateV2(join(dataDir, "providers"));
    for (const [id, provider] of Object.entries(generated)) {
      const models = [];
      for (const [modelId, model] of Object.entries(provider.models)) {
        const authoredFile = join(dataDir, "providers", id, "models", `${modelId}.toml`);
        const authored = Bun.TOML.parse(await Bun.file(authoredFile).text()) as { base_model?: string; base_model_omit?: string[] };
        const canonicalFile = model.canonical_id ? join(dataDir, "models", `${model.canonical_id}.toml`) : null;
        const canonical = canonicalFile && await Bun.file(canonicalFile).exists() ? Bun.TOML.parse(await Bun.file(canonicalFile).text()) as { links?: unknown[]; weights?: unknown[] } : null;
        models.push({ id: modelId, name: model.name, ...(model.canonical_id ? { canonical_id: model.canonical_id } : {}), release_date: model.release_date, release_date_precision: datePrecision(model.release_date), api_protocols: Object.keys(model.api), type: model.type, family: model.family, open_weights: model.open_weights, links: canonical?.links ?? [], ...(canonical?.weights ? { weights: canonical.weights } : {}), metadata_source: canonicalFile ? `models/${model.canonical_id}.toml` : null, metadata_scope: "Canonical lab links/weights, not an additional inference about the provider execution configuration", source_file: `providers/${id}/models/${modelId}.toml`, parse_status: "generator", excluded_fields: [], ...(authored.base_model_omit ? { base_model_omit: authored.base_model_omit } : {}) });
      }
      providers.push({ id, name: provider.name, models });
    }
  } catch (error) { status = "schema_incompatible"; problems.push(describeError(error)); }
  const diagnostics: { scanned_labs: number; scanned_provider_models: number; incompatible_files: { path: string; issues: unknown[] }[] } = { scanned_labs: 0, scanned_provider_models: 0, incompatible_files: [] };
  // The first generator failure must not hide the remaining schema incompatibilities.
  // This scan validates every authored data record without executing newer source code.
  if (status === "schema_incompatible") {
    for (const scope of ["models", "providers"] as const) {
      const glob = new Bun.Glob(scope === "models" ? "models/**/*.toml" : "providers/*/models/**/*.toml");
      for await (const relativePath of glob.scan({ cwd: dataDir, followSymlinks: true })) {
        try {
          const raw = Bun.TOML.parse(await Bun.file(join(dataDir, relativePath)).text()) as Record<string, unknown>;
          const { schema: _schema, ...data } = raw;
          const id = scope === "models" ? relativePath.slice("models/".length, -5) : providerModelId(relativePath);
          const result = (scope === "models" ? LabModelV2 : AuthoredModelV2).safeParse({ ...data, id });
          if (scope === "models") diagnostics.scanned_labs++; else diagnostics.scanned_provider_models++;
          if (!result.success) diagnostics.incompatible_files.push({ path: relativePath, issues: result.error.issues.map(issue => ({ code: issue.code, path: issue.path, message: issue.message, ...(issue.code === "unrecognized_keys" ? { keys: issue.keys } : {}) })) });
        } catch (error) { diagnostics.incompatible_files.push({ path: relativePath, issues: [describeError(error)] }); }
      }
    }
  }
  let compatibilityView: string | null = null;
  let compatibilityGenerationSucceeded: boolean | null = null;
  let dateProjectionSummary: Record<string, unknown> | null = null;
  if (status === "schema_incompatible") {
    const compatible = await generateCompatibleModels(dataDir, diagnostics.incompatible_files);
    compatibilityView = compatible.compatibilityView;
    compatibilityGenerationSucceeded = compatible.generationSucceeded;
    const { generated, excluded } = compatible;
    problems.push(...compatible.problems);
    const dateProjection = await projectFixedParserDates(dataDir, diagnostics.incompatible_files);
    dateProjectionSummary = dateProjection.summary;
    const outputProviders = new Map<string, { id: string; name: string; models: any[] }>();
    const rawFiles = new Bun.Glob("providers/*/models/**/*.toml");
    for await (const path of rawFiles.scan({ cwd: dataDir, followSymlinks: true })) {
      const id = path.split("/")[1]!; const modelId = providerModelId(path);
      let provider = outputProviders.get(id);
      if (!provider) {
        const authoredProvider = Bun.TOML.parse(await Bun.file(join(dataDir, "providers", id, "provider.toml")).text()) as { name?: string };
        provider = { id, name: authoredProvider.name ?? id, models: [] }; outputProviders.set(id, provider);
      }
      const raw = Bun.TOML.parse(await Bun.file(join(dataDir, path)).text()) as Record<string, any>;
      const resolvedModel = generated[id]?.models[modelId];
      const canonicalId = resolvedModel?.canonical_id ?? (typeof raw.base_model === "string" ? raw.base_model : undefined);
      const canonicalFile = canonicalId ? join(dataDir, "models", `${canonicalId}.toml`) : null;
      const canonical = canonicalFile && await Bun.file(canonicalFile).exists() ? Bun.TOML.parse(await Bun.file(canonicalFile).text()) as { links?: unknown[]; weights?: unknown[] } : null;
      const projectedDate = dateProjection.dates.get(path);
      const { date, source: dateSource } = referenceReleaseDate(resolvedModel?.release_date, projectedDate?.release_date, raw);
      const fieldIssues = excluded.get(path) ?? [];
      const excludedFields = resolvedModel ? [] : [...fieldIssues.flatMap(issue => typeof issue === "object" && issue && "path" in issue ? [(issue as { path: unknown[] }).path.join(".")] : []), projectedDate ? "unresolved_inherited_fields_except_release_date" : "unresolved_inherited_fields", "generated_api_defaults"];
      provider.models.push({ id: modelId, name: resolvedModel?.name ?? (typeof raw.name === "string" ? raw.name : modelId), name_source: resolvedModel ? "fixed_generator" : typeof raw.name === "string" ? "explicit_provider_field" : "identity_display_fallback", ...(canonicalId ? { canonical_id: canonicalId } : {}), canonical_source: resolvedModel ? "fixed_generator" : canonicalId ? "explicit_base_model" : null, release_date: date, release_date_precision: date ? datePrecision(date) : null, release_date_source: dateSource, ...(projectedDate ? { release_date_projection: { field: "release_date", ...projectedDate, policy: "Only the fixed parser date is consumed; projected tool/capability values are never published as facts" } } : {}), api_protocols: resolvedModel ? Object.keys(resolvedModel.api) : raw.api && typeof raw.api === "object" ? Object.keys(raw.api) : [], api_protocols_source: resolvedModel ? "fixed_generator" : "authored_only", type: resolvedModel?.type ?? raw.type ?? null, links: canonical?.links ?? [], ...(canonical?.weights ? { weights: canonical.weights } : {}), metadata_source: canonicalId ? `models/${canonicalId}.toml` : null, metadata_scope: "Canonical lab links/weights only; no manual date inheritance or execution configuration inference", source_file: path, parse_status: resolvedModel ? "generator" : "raw_partial", excluded_fields: excludedFields, ...(resolvedModel ? {} : { parse_issues: fieldIssues.length ? fieldIssues : [{ message: "Trusted generator did not emit this record (e.g. a legacy provider alias); only explicit authored fields retained" }] }), ...(Array.isArray(raw.base_model_omit) ? { base_model_omit: raw.base_model_omit } : {}) });
    }
    providers = [...outputProviders.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const provider of providers) provider.models.sort((a: any, b: any) => a.id.localeCompare(b.id));
    status = "partial";
  }
  const flattened = (providers as { models: { canonical_id?: string; api_protocols: string[]; parse_status: string }[] }[]).flatMap(provider => provider.models);
  const expectedPaths = new Set(await Array.fromAsync(new Bun.Glob("providers/*/models/**/*.toml").scan({ cwd: dataDir, followSymlinks: true })));
  const observedPaths = new Set<string>();
  for (const provider of providers) {
    const ids = new Set<string>();
    for (const model of provider.models) {
      if (ids.has(model.id)) throw new Error(`Duplicate latest reference model identity in provider ${provider.id}`);
      ids.add(model.id);
      const expectedPath = `providers/${provider.id}/models/${model.id}.toml`;
      if (model.source_file !== expectedPath || !expectedPaths.has(expectedPath)) throw new Error("Latest reference model ID does not equal its exact authored relative path");
      observedPaths.add(expectedPath);
    }
  }
  if (expectedPaths.size !== observedPaths.size || [...expectedPaths].some(path => !observedPaths.has(path))) throw new Error("Latest reference authored and output identity sets differ");
  const identityVerification = { status: "pass", method: "Every Provider exact relative authored model ID, including symlink aliases, equals the generated/raw-partial union; duplicate Provider/model keys rejected", authored_records: expectedPaths.size, output_records: observedPaths.size };
  const counts = { providers: providers.length, provider_models: flattened.length, protocol_identities: flattened.reduce((sum, model) => sum + model.api_protocols.length, 0), generator_models: flattened.filter(model => model.parse_status === "generator").length, raw_partial_models: flattened.filter(model => model.parse_status !== "generator").length, with_canonical_id: flattened.filter(model => !!model.canonical_id).length, distinct_canonical_ids: new Set(flattened.map(model => model.canonical_id).filter(Boolean)).size };
  await atomicWrite(outputPath, stableStringify({ schema_version: 1, status, source, counts, identity_verification: identityVerification, problems, schema_diagnostics: diagnostics, compatibility_view: compatibilityView, compatibility_generation_succeeded: compatibilityGenerationSucceeded, date_projection: dateProjectionSummary, providers }));
  console.log(stableStringify({ status, output: outputPath, source, counts, problem_count: problems.length, scanned_labs: diagnostics.scanned_labs, scanned_provider_models: diagnostics.scanned_provider_models, incompatible_files: diagnostics.incompatible_files.length }).trim());
  if (status !== "success") process.exitCode = 2;
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "Latest upstream validation failed"); process.exitCode = 1; });

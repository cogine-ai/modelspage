import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
          if (!result.success) diagnostics.incompatible_files.push({ path: relativePath, issues: result.error.issues.map(issue => ({ path: issue.path, message: issue.message })) });
        } catch (error) { diagnostics.incompatible_files.push({ path: relativePath, issues: [describeError(error)] }); }
      }
    }
  }
  let compatibilityView: string | null = null;
  if (status === "schema_incompatible") {
    const directory = resolve(".modelspage/full-validation"); await mkdir(directory, { recursive: true });
    compatibilityView = await mkdtemp(join(directory, "upstream-compatible-"));
    const copy = Bun.spawnSync(["cp", "-R", join(dataDir, "models"), join(dataDir, "providers"), compatibilityView], { stdout: "pipe", stderr: "pipe" });
    if (copy.exitCode !== 0) throw new Error("Could not prepare isolated compatibility data view");
    const excluded = new Map(diagnostics.incompatible_files.filter(file => file.path.startsWith("providers/")).map(file => [file.path, file.issues]));
    for (const path of excluded.keys()) await rm(join(compatibilityView, path));
    let generated: Awaited<ReturnType<typeof generateV2>> = {};
    for (let attempt = 0; attempt < 300; attempt++) {
      // A provider whose entire model set is incompatible is still kept in raw output.
      const providerFiles = new Bun.Glob("providers/*/provider.toml");
      for await (const path of providerFiles.scan({ cwd: compatibilityView, followSymlinks: true })) {
        const id = path.split("/")[1]!;
        if (!existsSync(join(compatibilityView, "providers", id, "models"))) continue;
        const files = await Array.fromAsync(new Bun.Glob("**/*.toml").scan({ cwd: join(compatibilityView, "providers", id, "models"), followSymlinks: true }));
        if (!files.length) await rm(join(compatibilityView, "providers", id), { recursive: true });
      }
      try { generated = await generateV2(join(compatibilityView, "providers")); break; }
      catch (error) {
        const cause = error instanceof Error ? error.cause as { modelPath?: string } | undefined : undefined;
        const path = cause?.modelPath?.startsWith(compatibilityView + "/") ? cause.modelPath.slice(compatibilityView.length + 1) : null;
        if (!path?.startsWith("providers/") || excluded.has(path)) { problems.push(describeError(error)); break; }
        const issues = [describeError(error)]; excluded.set(path, issues);
        diagnostics.incompatible_files.push({ path, issues });
        await rm(join(compatibilityView, path));
      }
    }
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
      const date = resolvedModel?.release_date ?? (typeof raw.release_date === "string" ? raw.release_date : null);
      const fieldIssues = excluded.get(path) ?? [];
      const excludedFields = resolvedModel ? [] : [...fieldIssues.flatMap(issue => typeof issue === "object" && issue && "path" in issue ? [(issue as { path: unknown[] }).path.join(".")] : []), "unresolved_inherited_fields", "generated_api_defaults"];
      provider.models.push({ id: modelId, name: resolvedModel?.name ?? (typeof raw.name === "string" ? raw.name : modelId), name_source: resolvedModel ? "fixed_generator" : typeof raw.name === "string" ? "explicit_provider_field" : "identity_display_fallback", ...(canonicalId ? { canonical_id: canonicalId } : {}), canonical_source: resolvedModel ? "fixed_generator" : canonicalId ? "explicit_base_model" : null, release_date: date, release_date_precision: date ? datePrecision(date) : null, release_date_source: resolvedModel ? "fixed_generator" : date ? "explicit_provider_field" : null, api_protocols: resolvedModel ? Object.keys(resolvedModel.api) : raw.api && typeof raw.api === "object" ? Object.keys(raw.api) : [], api_protocols_source: resolvedModel ? "fixed_generator" : "authored_only", type: resolvedModel?.type ?? raw.type ?? null, links: canonical?.links ?? [], ...(canonical?.weights ? { weights: canonical.weights } : {}), metadata_source: canonicalId ? `models/${canonicalId}.toml` : null, metadata_scope: "Canonical lab links/weights only; no manual date inheritance or execution configuration inference", source_file: path, parse_status: resolvedModel ? "generator" : "raw_partial", excluded_fields: excludedFields, ...(resolvedModel ? {} : { parse_issues: fieldIssues.length ? fieldIssues : [{ message: "Trusted generator did not emit this record (e.g. a legacy provider alias); only explicit authored fields retained" }] }), ...(Array.isArray(raw.base_model_omit) ? { base_model_omit: raw.base_model_omit } : {}) });
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
  await atomicWrite(outputPath, stableStringify({ schema_version: 1, status, source, counts, identity_verification: identityVerification, problems, schema_diagnostics: diagnostics, compatibility_view: compatibilityView, providers }));
  console.log(stableStringify({ status, output: outputPath, source, counts, problem_count: problems.length, scanned_labs: diagnostics.scanned_labs, scanned_provider_models: diagnostics.scanned_provider_models, incompatible_files: diagnostics.incompatible_files.length }).trim());
  if (status !== "success") process.exitCode = 2;
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "Latest upstream validation failed"); process.exitCode = 1; });

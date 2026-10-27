/** @jsx jsx */
/** @jsxImportSource hono/jsx */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelMetadata, Provider } from "@models.dev/core";
import { buildRankingDataset } from "./data.ts";
import { validateBundle } from "../src/schema.ts";
import { bundleRevision } from "../src/integrity.ts";
import type { Bundle } from "../src/types.ts";
import { licensePath, upstreamLicense } from "./site.ts";
import { selectPublishedDataset } from "./version.ts";

type Page = { html: string; metadata: { title: string; description: string } };
type Section = "models" | "providers" | "labs" | "rankings" | "data";
type RenderPage = (active: Section, content: unknown, metadata?: Page["metadata"]) => Page;

export const AdditionalFiles = new Map<string, string>();
AdditionalFiles.set(licensePath, upstreamLicense);

export function extendPages(pages: Map<string, Page>, catalog: { models: Record<string, ModelMetadata>; providers: Record<string, Provider> }, renderPage: RenderPage) {
  const lock = JSON.parse(readFileSync(resolve(import.meta.dir, "../upstream.lock.json"), "utf8"));
  const input = process.env.MODELSPAGE_WEB_CATALOG;
  const publicBuild = process.env.MODELSPAGE_WEB_MODE === "public";
  if (publicBuild && !input) throw new Error("Public web builds require a validated C/P/N catalog input");
  const bundle = input ? validateBundle(JSON.parse(readFileSync(resolve(input), "utf8"))) : emptyBundle(lock);
  if (input && bundleRevision(bundle) !== bundle.revision) throw new Error("Web preview catalog revision does not match its content");
  let dataset = buildRankingDataset(bundle, catalog.models, catalog.providers, {
    now: bundle.published_at,
    audience: publicBuild ? "public" : "local-preview",
    canonical_source: { commit: lock.commit, retrieved_at: lock.synced_at ?? lock.imported_at, url: lock.repository },
  });
  if (publicBuild) {
    const previous = process.env.MODELSPAGE_WEB_PREVIOUS_RANKINGS;
    dataset = selectPublishedDataset(dataset, previous ? JSON.parse(readFileSync(previous, "utf8")) : undefined);
  }
  AdditionalFiles.set("/rankings.json", JSON.stringify(dataset));
  AdditionalFiles.set("/rankings.schema.json", readFileSync(resolve(import.meta.dir, "../schema/web-rankings.schema.json"), "utf8"));

  pages.set("/rankings", renderPage("rankings", <RankingsPage dataset={dataset} />, {
    title: "Rankings | Modelspage", description: "Model intelligence, popularity, and release rankings.",
  }));
  pages.set("/data", renderPage("data", <DataPage dataset={dataset} />, {
    title: "Data | Modelspage", description: "Model catalogs and ranking datasets in JSON.",
  }));
}

function emptyBundle(lock: { commit: string; imported_at: string; repository: string }): Bundle {
  return {
    schema_version: 2, revision: lock.commit, builder_version: "web-local-preview", publication_sequence: 1,
    published_at: lock.imported_at, source_revisions: [], metric_profiles: [], attribution: [],
    module_compatibility: { projection: 2, min_consumer_version: "2.0.0" },
    facts: [], mappings: [], corrections: [], fixture: false,
  };
}

type Dataset = ReturnType<typeof buildRankingDataset>;
function RankingsPage({ dataset }: { dataset: Dataset }) {
  const labs = [...new Set(dataset.models.map(model => model.lab_id))].sort();
  return <section class="ranking-page" id="ranking-app">
    <div class="ranking-heading"><h2>Rankings</h2><a href="/rankings.json" class="ranking-download">JSON ↗</a></div>
    <div class="ranking-toolbar">
      <div class="ranking-segment" role="group" aria-label="Rank by">
        <button type="button" data-metric="popularity" aria-pressed="true">Popularity</button>
        <button type="button" data-metric="capability" aria-pressed="false">Intelligence</button>
        <button type="button" data-metric="newest" aria-pressed="false">Newest</button>
      </div>
      <div class="ranking-segment ranking-views" role="group" aria-label="View">
        <button type="button" data-view="chart" aria-pressed="true">Chart</button>
        <button type="button" data-view="table" aria-pressed="false">Table</button>
        <button type="button" data-view="compare" aria-pressed="false">Compare</button>
      </div>
    </div>
    <div class="ranking-filters">
      <input id="ranking-search" type="search" aria-label="Filter ranking models" placeholder="Filter models…" autocomplete="off" />
      <select id="ranking-lab" aria-label="Filter by lab"><option value="">All labs</option>{labs.map(lab => <option value={lab}>{lab}</option>)}</select>
      <select id="ranking-provider" aria-label="Filter by provider"><option value="">All providers</option>{Object.entries(dataset.provider_names).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option value={id}>{name}</option>)}</select>
      <span id="ranking-count" aria-live="polite"></span>
    </div>
    <div class="ranking-chart-heading"><h3 id="ranking-title">Popularity</h3><span id="ranking-context"></span></div>
    <div id="ranking-results" aria-busy="true"><p class="ranking-empty">Loading…</p></div>
    <button type="button" id="ranking-more" hidden>Show more</button>
    <div class="ranking-footer"><a href="/data">Data & sources ↗</a></div>
    <dialog id="ranking-detail" class="ranking-detail" aria-labelledby="ranking-detail-title"><button type="button" id="ranking-detail-close" aria-label="Close model ranking details">×</button><div id="ranking-detail-body"></div></dialog>
  </section>;
}

function DataPage({ dataset }: { dataset: Dataset }) {
  const c = dataset.models.filter(model => model.c !== null).length;
  const p = dataset.models.filter(model => model.p !== null).length;
  const n = dataset.models.filter(model => model.n !== null).length;
  return <section class="ranking-page data-page">
    <div class="ranking-heading"><h2>Data</h2></div>
    <div class="dataset-list">
      <article><div><h3>Model catalog</h3><span>models.dev</span></div><dl><div><dt>Models</dt><dd>{dataset.models.length}</dd></div><div><dt>Providers</dt><dd>{Object.keys(dataset.provider_names).length}</dd></div></dl><a href="/catalog.json?type=all" download="modelspage-catalog.json">Download JSON ↓</a></article>
      <article><div><h3>Rankings</h3><span>Intelligence · Popularity · Newest</span></div><dl><div><dt>C</dt><dd>{c}</dd></div><div><dt>P</dt><dd>{p}</dd></div><div><dt>N</dt><dd>{n}</dd></div></dl><a href="/rankings.json" download="modelspage-rankings.json">Download JSON ↓</a></article>
    </div>
    <h3 class="data-section-heading">Endpoints</h3>
    <div class="data-endpoints"><a href="/models.json?type=all"><code>/models.json?type=all</code><span>Canonical models ↗</span></a><a href="/api.json?type=all"><code>/api.json?type=all</code><span>Provider models ↗</span></a><a href="/catalog.json?type=all"><code>/catalog.json?type=all</code><span>Full catalog ↗</span></a><a href="/rankings.json"><code>/rankings.json</code><span>C / P / N ↗</span></a><a href="/experimental/v2.0/api.json"><code>/experimental/v2.0/api.json</code><span>Experimental v2 ↗</span></a></div>
    <h3 class="data-section-heading" id="sources">Sources</h3>
    <div class="data-sources"><a href="https://github.com/anomalyco/models.dev" target="_blank" rel="noreferrer">models.dev <span>Catalog · Prices · Dates ↗</span></a><a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">Artificial Analysis <span>Intelligence ↗</span></a><a href="https://openrouter.ai/rankings" target="_blank" rel="noreferrer">OpenRouter <span>Popularity · 60% ↗</span></a><a href="https://vercel.com/ai-gateway/leaderboards" target="_blank" rel="noreferrer">Vercel AI Gateway <span>Popularity · 30% ↗</span></a><a href="https://opencode.ai/data" target="_blank" rel="noreferrer">OpenCode Go / Free <span>Popularity · 10% ↗</span></a></div>
    <details class="data-attribution"><summary>Attribution</summary><div>{dataset.sources.filter(source => ["artificial-analysis", "openrouter", "vercel-ai-gateway", "opencode-go-free"].includes(source.id)).map(source => <p><a href={source.url ?? "#sources"}>{source.id}</a>{" · "}{source.data_as_of ? `As of ${source.data_as_of}` : `Retrieved ${source.retrieved_at ?? "—"}`}{["openrouter", "vercel-ai-gateway"].includes(source.id) ? <span> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></span> : null}</p>)}<p>Model identities joined; daily source shares combined with fixed weights.</p><a href="/rankings.schema.json">JSON schema ↗</a></div></details>
    <details class="data-revisions"><summary>Versions</summary><dl><dt>Catalog</dt><dd><code>{dataset.canonical_source.commit}</code></dd><dt>Rankings</dt><dd><code>{dataset.revision}</code></dd><dt>Snapshot</dt><dd>{dataset.published_at}</dd></dl></details>
    <p class="data-license">Based on <a href="https://github.com/anomalyco/models.dev" target="_blank" rel="noreferrer">models.dev</a> · <a href={licensePath}>MIT License</a></p>
  </section>;
}

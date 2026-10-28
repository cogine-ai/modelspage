import { expect, test } from "bun:test";
import { buildRankingDataset, type CatalogModel, type CatalogProvider, type WebRankingDataset } from "../web/data.js";
import { pageStructuredData, rankingStructuredList, serializeStructuredData, type StructuredNode } from "../web/structured-data.js";
import { bundle, capability, known, model, timestamp } from "./contract-fixture.js";
import type { ModelFacts, Popularity } from "../src/types.js";

const origin = "https://models.example.test";
const metadata = { title: "Modelspage", description: "AI model specifications, providers, prices, and rankings." };
const ids = {
  measured: "Lab-X/Model:One+free",
  zero: "Lab-X/model:One+free",
  capability: "Other/C-only",
  newest: "Other/N-only",
  unknown: "Other/Unknown:v1",
  month: "Other/Month",
  future: "Other/Future",
};
const weights = { openrouter: 0.6, "vercel-ai-gateway": 0.3, "opencode-go-free": 0.1 };
const dates = ["2026-10-24"];

function measuredPopularity(score: number, position: number, id: string) {
  return known<Popularity>({
    source_id: "fixture", source_model_id: id, position, ranking_eligible: true,
    weighted: {
      method_id: "fixture", score, dates, weights,
      sources: {
        openrouter: { weight: 0.6, score: score / 0.6, contribution: score, observed_days: 1, missing_days: [], daily_shares: { "2026-10-24": score / 0.6 } },
        "vercel-ai-gateway": { weight: 0.3, score: null, contribution: null, observed_days: 0, missing_days: dates, daily_shares: { "2026-10-24": null } },
        "opencode-go-free": { weight: 0.1, score: null, contribution: null, observed_days: 0, missing_days: dates, daily_shares: { "2026-10-24": null } },
      },
    },
  });
}

function fixture() {
  const models: Record<string, CatalogModel> = Object.fromEntries(Object.values(ids).map(id => [id, { name: id, release_date: "2026-10-01" }]));
  models[ids.unknown]!.release_date = undefined;
  models[ids.month]!.release_date = "2026-10";
  models[ids.future]!.release_date = "2027-01-01";
  models[ids.newest]!.release_date = "2026-10-24";
  const facts: ModelFacts[] = [
    model(ids.measured, { canonical_id: ids.measured, capability: capability(40), popularity: measuredPopularity(12, 1, ids.measured) }),
    model(ids.zero, { canonical_id: ids.zero, capability: capability(0), popularity: measuredPopularity(0, 2, ids.zero) }),
    model(ids.capability, { canonical_id: ids.capability, capability: capability(80) }),
  ];
  const input = bundle({
    schema_version: 2, revision: "a".repeat(64), module_compatibility: { projection: 2, min_consumer_version: "2.0.0" }, facts,
    ranking_defaults: { capability_profile_id: "fixture-profile", popularity_source_id: "fixture", policy_id: "fixture" },
  });
  input.source_revisions[0]!.window = { start: dates[0]!, end: dates[0]! };
  input.source_revisions[0]!.popularity_method = { id: "fixture", dates, weights };
  input.source_revisions.push({ ...input.source_revisions[0]!, id: "artificial-analysis", popularity_method: undefined, url: "https://artificialanalysis.ai/" });
  const providers: Record<string, CatalogProvider> = {
    "provider-a": { name: "A", models: Object.fromEntries(Object.values(ids).map(id => [id, { canonical_model_id: id }])) },
  };
  const dataset = buildRankingDataset(input, models, providers, {
    now: timestamp,
    canonical_source: { commit: "b".repeat(40), retrieved_at: "2026-10-24T12:00:00.000Z", url: "https://github.com/anomalyco/models.dev" },
  });
  return { catalog: { models }, dataset };
}

function nodeOfType(graph: StructuredNode[], type: string) {
  const node = graph.find(node => node["@type"] === type);
  if (!node) throw new Error(`Expected ${type} node`);
  return node;
}
const elements = (node: StructuredNode) => node.itemListElement as StructuredNode[];
const memberIds = (node: StructuredNode) => elements(node).map(element => ((element.item ?? element) as StructuredNode).identifier);
const orderedRows = (dataset: WebRankingDataset, metric: keyof WebRankingDataset["order"]) => dataset.order[metric].map(id => dataset.models.find(model => model.id === id)!);

test("model directory retains exact identities as unordered members and encodes model URL segments", () => {
  const { catalog, dataset } = fixture();
  for (const route of ["/", "/models"]) {
    const graph = pageStructuredData(origin, route, metadata, catalog, dataset)["@graph"];
    const page = nodeOfType(graph, "CollectionPage"), list = nodeOfType(graph, "ItemList");
    expect(page.mainEntity).toEqual({ "@id": list["@id"] });
    expect(list.itemListOrder).toBe("https://schema.org/ItemListUnordered");
    expect(list.numberOfItems).toBe(Object.values(ids).length);
    expect(new Set(memberIds(list))).toEqual(new Set(Object.values(ids)));
    expect(elements(list).every(member => !("position" in member))).toBe(true);
    const links = new Map(elements(list).map(member => [member.identifier, member.url]));
    expect(links.get(ids.measured)).toBe(`${origin}/models/Lab-X/Model%3AOne%2Bfree/`);
    expect(links.get(ids.zero)).toBe(`${origin}/models/Lab-X/model%3AOne%2Bfree/`);
    expect(links.get(ids.unknown)).toBe(`${origin}/models/Other/Unknown%3Av1/`);
  }
});

test("dataset catalog connects two actual JSON downloads without turning its discovery manifest into data", () => {
  const { catalog, dataset } = fixture();
  const graph = pageStructuredData(origin, "/data", metadata, catalog, dataset)["@graph"];
  const dataCatalog = nodeOfType(graph, "DataCatalog"), datasets = graph.filter(node => node["@type"] === "Dataset");
  expect(nodeOfType(graph, "CollectionPage").mainEntity).toEqual({ "@id": dataCatalog["@id"] });
  expect(datasets).toHaveLength(2);
  expect(dataCatalog.dataset).toEqual(datasets.map(node => ({ "@id": node["@id"] })));
  const downloads = datasets.flatMap(node => node.distribution as StructuredNode[]);
  expect(downloads.map(download => download.contentUrl).sort()).toEqual([`${origin}/catalog.json?type=all`, `${origin}/rankings.json`].sort());
  expect(downloads.every(download => download["@type"] === "DataDownload" && download.encodingFormat === "application/json")).toBe(true);
  expect(downloads.every(download => !String(download.contentUrl).includes("manifest"))).toBe(true);
  for (const node of datasets) {
    expect(typeof node.name).toBe("string");
    expect(String(node.description).length).toBeGreaterThanOrEqual(50);
    expect(String(node.description).length).toBeLessThanOrEqual(5000);
    expect(node.includedInDataCatalog).toEqual({ "@id": dataCatalog["@id"] });
  }
  const catalogNode = datasets.find(node => (node.distribution as StructuredNode[]).some(download => String(download.contentUrl).includes("catalog.json")))!;
  const rankingNode = datasets.find(node => node !== catalogNode)!;
  expect(catalogNode.license).toBe(`${origin}/licenses/models-dev.txt`);
  expect(catalogNode.creator).toMatchObject({ name: "models.dev", url: "https://models.dev/" });
  expect(rankingNode.creator).toEqual(rankingNode.publisher);
  expect(rankingNode).not.toHaveProperty("license");
  expect(dataCatalog).not.toHaveProperty("license");
  expect(rankingNode.isBasedOn).toContainEqual({ "@type": "CreativeWork", name: "artificial-analysis", url: "https://artificialanalysis.ai/" });
  expect(rankingNode).not.toHaveProperty("sameAs");
  expect(rankingNode).not.toHaveProperty("temporalCoverage");
});

test("dataset versions and modification dates describe published facts rather than the latest retrieval", () => {
  const { catalog, dataset } = fixture();
  const changedRetrieval = structuredClone(dataset);
  changedRetrieval.canonical_source.retrieved_at = "2026-10-28T00:00:00.000Z";
  for (const current of [dataset, changedRetrieval]) {
    const graph = pageStructuredData(origin, "/data", metadata, catalog, current)["@graph"];
    const datasets = graph.filter(node => node["@type"] === "Dataset");
    const catalogNode = datasets.find(node => node.license)!;
    const rankingNode = datasets.find(node => node !== catalogNode)!;
    expect(catalogNode.version).toBe(dataset.canonical_source.commit);
    expect(catalogNode).not.toHaveProperty("dateModified");
    expect(catalogNode).not.toHaveProperty("datePublished");
    expect(rankingNode.version).toBe(dataset.revision);
    expect(rankingNode.dateModified).toBe(timestamp);
    expect(rankingNode.dateModified).not.toBe(current.canonical_source.retrieved_at);
  }
});

test("popularity lists preserve measured zero and exclude C/N fallbacks and unknown members", () => {
  const { catalog, dataset } = fixture(), rows = orderedRows(dataset, "popularity");
  const first = rankingStructuredList(origin, rows, "popularity", "chart", 1);
  expect(first.numberOfItems).toBe(2);
  expect(memberIds(first)).toEqual([ids.measured]);
  const expanded = rankingStructuredList(origin, rows, "popularity", "table", 30);
  expect(memberIds(expanded)).toEqual([ids.measured, ids.zero]);
  expect(elements(expanded).map(member => member.position)).toEqual([1, 2]);
  expect(dataset.models.find(model => model.id === ids.zero)!.p).toBe(0);
  expect(rows.find(model => model.id === ids.capability)!.c).toBe(80);
  const graph = pageStructuredData(origin, "/rankings", metadata, catalog, dataset)["@graph"];
  expect(memberIds(nodeOfType(graph, "ItemList"))).toEqual([ids.measured, ids.zero]);
  expect(serializeStructuredData({ "@context": "https://schema.org", "@graph": graph })).not.toMatch(/AggregateRating|ratingValue|"@type":"Product"|"@type":"Offer"/);
});

test("visible limits never pull a ranked member from beyond the rendered slice", () => {
  const { dataset } = fixture();
  const unknown = dataset.models.find(model => model.id === ids.unknown)!;
  const measured = dataset.models.find(model => model.id === ids.measured)!;
  const list = rankingStructuredList(origin, [unknown, measured], "popularity", "chart", 1);
  expect(list.numberOfItems).toBe(1);
  expect(elements(list)).toHaveLength(0);
});

test("capability, release and filtered lists retain their own measurable membership", () => {
  const { dataset } = fixture();
  const capabilityRows = orderedRows(dataset, "capability");
  const capabilityList = rankingStructuredList(origin, capabilityRows, "capability", "table", 30);
  expect(capabilityList.itemListOrder).toBe("https://schema.org/ItemListOrderDescending");
  expect(memberIds(capabilityList)).toEqual([ids.capability, ids.measured, ids.zero]);
  expect(capabilityList.numberOfItems).toBe(3);
  const releaseList = rankingStructuredList(origin, orderedRows(dataset, "newest"), "newest", "chart", 30);
  expect(releaseList.itemListOrder).toBe("https://schema.org/ItemListOrderDescending");
  expect(releaseList.numberOfItems).toBe(4);
  expect(memberIds(releaseList)[0]).toBe(ids.newest);
  expect(memberIds(releaseList)).not.toContain(ids.month);
  expect(memberIds(releaseList)).not.toContain(ids.future);
  expect(memberIds(releaseList)).not.toContain(ids.unknown);
  const filtered = rankingStructuredList(origin, capabilityRows.filter(model => model.lab_id === "Lab-X"), "capability", "table", 1);
  expect(filtered.numberOfItems).toBe(2);
  expect(memberIds(filtered)).toEqual([ids.measured]);
});

test("comparison describes an unordered C/P intersection with no fabricated ranks or visibility limit", () => {
  const { dataset } = fixture();
  const list = rankingStructuredList(origin, orderedRows(dataset, "popularity"), "popularity", "compare", 1);
  expect(list.itemListOrder).toBe("https://schema.org/ItemListUnordered");
  expect(list.numberOfItems).toBe(2);
  expect(new Set(memberIds(list))).toEqual(new Set([ids.measured, ids.zero]));
  expect(elements(list).every(member => member["@type"] === "Thing" && !("position" in member))).toBe(true);
});

test("embedded JSON-LD cannot be terminated by a model name while preserving its JSON value", () => {
  const { catalog, dataset } = fixture();
  const unsafeName = 'A </ScRiPt><script>alert("fixture")</script> & \u2028 \u2029';
  catalog.models[ids.measured]!.name = unsafeName;
  const graph = pageStructuredData(origin, "/models", metadata, catalog, dataset);
  const serialized = serializeStructuredData(graph);
  expect(serialized).not.toMatch(/<\/script/i);
  expect(serialized).not.toContain("\u2028");
  expect(serialized).not.toContain("\u2029");
  const embedded = `<script type="application/ld+json">${serialized}</script>`;
  expect(embedded.match(/<\/script/gi)).toHaveLength(1);
  const decoded = JSON.parse(serialized);
  const member = elements(nodeOfType(decoded["@graph"], "ItemList")).find(member => member.identifier === ids.measured)!;
  expect(member.name).toBe(unsafeName);
});

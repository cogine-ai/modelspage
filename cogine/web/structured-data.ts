import type { WebRankingDataset, WebRankingModel } from "./data.ts";
import { rankingLicenseName, rankingLicensePath, rankingLicenseVersion } from "./ranking-license.ts";

export const structuredDataId = "modelspage-structured-data";
export type StructuredNode = Record<string, unknown>;
export type StructuredData = { "@context": "https://schema.org"; "@graph": StructuredNode[] };
type Metadata = { title: string; description: string };
type Catalog = { models: Record<string, { name: string; description?: string }> };
type Metric = "popularity" | "capability" | "newest";
type View = "chart" | "table" | "compare";

const pageUrl = (origin: string, route: string) => new URL(route === "/" ? "/" : `${route.replace(/\/$/, "")}/`, origin).href;
const modelPath = (id: string) => `/models/${id.split("/").map(encodeURIComponent).join("/")}`;
const ref = (id: string) => ({ "@id": id });

function modelEntity(origin: string, id: string, name: string): StructuredNode {
  const url = pageUrl(origin, modelPath(id));
  return { "@type": "Thing", "@id": `${url}#model`, name, identifier: id, url };
}

/** Only measured members are ranked; the C/N fallback order is not a P observation. */
export function rankingStructuredList(origin: string, rows: WebRankingModel[], metric: Metric, view: View, limit: number): StructuredNode {
  const measured = (model: WebRankingModel) => view === "compare" ? model.c !== null && model.p !== null : metric === "newest" ? model.n !== null : metric === "capability" ? model.c !== null : model.p !== null;
  const visible = (view === "compare" ? rows : rows.slice(0, limit)).filter(measured);
  return {
    "@type": "ItemList", "@id": `${pageUrl(origin, "/rankings")}#ranking-list`,
    name: view === "compare" ? "Intelligence × Popularity" : metric === "popularity" ? "Popularity" : metric === "capability" ? "Intelligence" : "Release date",
    itemListOrder: `https://schema.org/ItemList${view === "compare" ? "Unordered" : "OrderDescending"}`,
    numberOfItems: rows.filter(measured).length,
    itemListElement: visible.map((model, index) => view === "compare"
      ? modelEntity(origin, model.id, model.name)
      : { "@type": "ListItem", position: index + 1, item: modelEntity(origin, model.id, model.name) }),
  };
}

function datasets(origin: string, dataset: WebRankingDataset) {
  const url = pageUrl(origin, "/data"), catalogId = `${url}#data-catalog`;
  const source = { "@type": "CreativeWork", name: "models.dev", url: dataset.canonical_source.url, ...(dataset.canonical_source.commit ? { version: dataset.canonical_source.commit } : {}) };
  const download = (name: string, path: string) => ({ "@type": "DataDownload", name, encodingFormat: "application/json", contentUrl: new URL(path, origin).href });
  const common = { url, isAccessibleForFree: true, publisher: ref(new URL("/#publisher", origin).href), includedInDataCatalog: ref(catalogId) };
  const catalog: StructuredNode = {
    "@type": "Dataset", "@id": `${url}#model-catalog`, name: "Modelspage model catalog",
    description: "AI model specifications, providers, pricing, context limits, modalities, and release dates from models.dev.",
    ...common, isBasedOn: source, license: new URL("/licenses/models-dev.txt", origin).href,
    creator: { "@type": "Organization", name: "models.dev", url: "https://models.dev/" },
    ...(dataset.canonical_source.commit ? { version: dataset.canonical_source.commit } : {}),
    distribution: [download("Full model catalog", "/catalog.json?type=all")],
  };
  const sources = dataset.sources.filter(source => ["artificial-analysis", "openrouter", "vercel-ai-gateway", "opencode-go-free"].includes(source.id) && source.url);
  const rankings: StructuredNode = {
    "@type": "Dataset", "@id": `${url}#rankings`, name: "Modelspage model rankings",
    description: "AI model intelligence scores, weighted popularity observations, release dates, and their source provenance in JSON.",
    ...common, version: dataset.revision, dateModified: dataset.published_at,
    creator: common.publisher,
    license: { "@type": "CreativeWork", name: rankingLicenseName, version: rankingLicenseVersion, url: new URL(rankingLicensePath, origin).href },
    variableMeasured: ["Model intelligence score", "Weighted popularity index", "Model release date"],
    isBasedOn: [source, ...sources.map(source => ({ "@type": "CreativeWork", name: source.id, url: source.url }))],
    distribution: [download("Model rankings", "/rankings.json")],
  };
  const dataCatalog: StructuredNode = {
    "@type": "DataCatalog", "@id": catalogId, name: "Modelspage data", url,
    dataset: [ref(catalog["@id"] as string), ref(rankings["@id"] as string)],
  };
  return { catalog, rankings, dataCatalog };
}

export function rankingStructuredDataset(origin: string, dataset: WebRankingDataset) {
  return datasets(origin, dataset).rankings;
}

export function pageStructuredData(origin: string, route: string, metadata: Metadata, catalog: Catalog, dataset: WebRankingDataset): StructuredData {
  const url = pageUrl(origin, route), siteId = new URL("/#website", origin).href, publisherId = new URL("/#publisher", origin).href;
  const collection = ["/", "/models", "/rankings", "/data"].includes(route);
  const page: StructuredNode = {
    "@type": collection ? "CollectionPage" : "WebPage", "@id": `${url}#webpage`, url,
    name: metadata.title, description: metadata.description, isPartOf: ref(siteId),
  };
  const graph: StructuredNode[] = [
    { "@type": "Organization", "@id": publisherId, name: "Modelspage", url: pageUrl(origin, "/") },
    { "@type": "WebSite", "@id": siteId, name: "Modelspage", url: pageUrl(origin, "/"), publisher: ref(publisherId) },
    page,
  ];
  if (route === "/" || route === "/models") {
    const list: StructuredNode = {
      "@type": "ItemList", "@id": `${url}#model-list`, name: "Models",
      itemListOrder: "https://schema.org/ItemListUnordered", numberOfItems: Object.keys(catalog.models).length,
      itemListElement: Object.entries(catalog.models).map(([id, model]) => modelEntity(origin, id, model.name)),
    };
    page.mainEntity = ref(list["@id"] as string);
    graph.push(list);
  } else if (route.startsWith("/models/")) {
    const id = route.slice("/models/".length).split("/").map(decodeURIComponent).join("/");
    const model = catalog.models[id];
    if (model) {
      const entity: StructuredNode = { ...modelEntity(origin, id, model.name), ...(model.description ? { description: model.description } : {}) };
      page.mainEntity = ref(entity["@id"] as string);
      graph.push(entity);
    }
  } else if (route === "/rankings" || route === "/data") {
    const { catalog: modelCatalog, rankings, dataCatalog } = datasets(origin, dataset);
    if (route === "/data") {
      page.mainEntity = ref(dataCatalog["@id"] as string);
      graph.push(dataCatalog, modelCatalog, rankings);
    } else {
      const models = new Map(dataset.models.map(model => [model.id, model]));
      const list = rankingStructuredList(origin, dataset.order.popularity.map(id => models.get(id)!), "popularity", "chart", 30);
      page.mainEntity = ref(list["@id"] as string);
      page.about = ref(rankings["@id"] as string);
      graph.push(list, rankings);
    }
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

export function serializeStructuredData(data: StructuredData) {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

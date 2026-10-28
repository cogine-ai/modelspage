import type { WebRankingDataset, WebRankingModel } from "./data.ts";
import { costSummary, escapeHtml } from "../../packages/web/src/shared.ts";
import { rankingStructuredDataset, rankingStructuredList, serializeStructuredData, structuredDataId, type StructuredData } from "./structured-data.ts";

document.querySelectorAll<HTMLElement>("[data-site-url]").forEach(element => {
  element.textContent = new URL(element.dataset.siteUrl!, location.origin).href;
});

const app = document.getElementById("ranking-app");
if (app) void startRankings();

type Metric = "popularity" | "capability" | "newest";
type View = "chart" | "table" | "compare";
const number = (value: number | null, digits = 2) => value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const h = escapeHtml;
const aaCredit = (label = "Artificial Analysis") => `<a class="aa-credit" href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer"><img src="/source-logos/artificial-analysis.svg" width="18" height="18" alt=""><span>${h(label)} ↗</span></a>`;
const niceMax = (values: Array<number | null>) => {
  const max = Math.max(0, ...values.filter((value): value is number => value !== null));
  if (!max) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / step) * step;
};

async function startRankings() {
  const results = document.getElementById("ranking-results")!;
  const count = document.getElementById("ranking-count")!;
  const title = document.getElementById("ranking-title")!;
  const context = document.getElementById("ranking-context")!;
  const search = document.getElementById("ranking-search") as HTMLInputElement;
  const lab = document.getElementById("ranking-lab") as HTMLSelectElement;
  const provider = document.getElementById("ranking-provider") as HTMLSelectElement;
  const more = document.getElementById("ranking-more") as HTMLButtonElement;
  const detail = document.getElementById("ranking-detail") as HTMLDialogElement;
  const schemaElement = document.getElementById(structuredDataId);
  const schema: StructuredData | null = schemaElement ? JSON.parse(schemaElement.textContent!) : null;
  const siteUrl = schema?.["@graph"].find(node => node["@type"] === "WebSite")?.url as string | undefined;
  const params = new URLSearchParams(location.search);
  let metric: Metric = ["capability", "newest"].includes(params.get("metric") ?? "") ? params.get("metric") as Metric : "popularity";
  let view: View = ["table", "compare"].includes(params.get("view") ?? "") ? params.get("view") as View : "chart";
  let limit = 30;
  search.value = params.get("q") ?? "";
  lab.value = params.get("lab") ?? "";
  provider.value = params.get("provider") ?? "";
  let data: WebRankingDataset;
  try {
    const response = await fetch("/rankings.json");
    if (!response.ok) throw new Error(`Rankings request failed (${response.status})`);
    data = await response.json() as WebRankingDataset;
  } catch (error) {
    results.innerHTML = '<p class="ranking-empty">Rankings could not load. <button type="button" id="ranking-retry">Retry</button></p>';
    results.setAttribute("aria-busy", "false");
    schemaElement?.remove();
    document.getElementById("ranking-retry")?.addEventListener("click", () => location.reload());
    console.error(error);
    return;
  }
  if (schema && siteUrl) {
    const dataset = rankingStructuredDataset(siteUrl, data);
    const index = schema["@graph"].findIndex(node => node["@id"] === dataset["@id"]);
    schema["@graph"][index] = dataset;
  }
  const models = new Map(data.models.map(model => [model.id, model]));
  const maxP = niceMax(data.models.map(model => model.p));
  const maxC = niceMax(data.models.map(model => model.c));
  const profile = data.profiles.find(item => item.id === data.defaults?.capability_profile_id);
  const source = data.sources.find(item => item.id === data.defaults?.popularity_source_id);
  const pWindow = source?.window.start ? `${source.window.start} — ${source.window.end} UTC` : "No observations";

  const modelLink = (model: WebRankingModel) => `<a class="ranking-model-link" href="${h(model.href)}"><img src="/logos/labs/${encodeURIComponent(model.lab_id)}.svg" alt="" width="20" height="20" onerror="this.hidden=true"><span>${h(model.name)}</span></a>`;
  const score = (model: WebRankingModel) => metric === "popularity" ? model.p : model.c;
  const metricValue = (model: WebRankingModel) => metric === "newest" ? releaseLabel(model) : number(score(model), metric === "capability" ? 1 : 3);
  function releaseLabel(model: WebRankingModel) {
    return model.release.state === "known" ? model.release.value.date : "—";
  }
  function filtered() {
    const query = search.value.trim().toLocaleLowerCase();
    // The server supplies the full total order; filters never recompute the ranks.
    return data.order[metric].map(id => models.get(id)!).filter(model => (!query || `${model.name} ${model.id}`.toLocaleLowerCase().includes(query)) && (!lab.value || model.lab_id === lab.value) && (!provider.value || model.providers.includes(provider.value)));
  }
  function saveUrl() {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({ metric, view, q: search.value, lab: lab.value, provider: provider.value })) {
      if (!value || key === "metric" && value === "popularity" || key === "view" && value === "chart") url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    history.replaceState(null, "", url);
  }
  function render() {
    const rows = filtered();
    app!.querySelectorAll<HTMLButtonElement>("[data-metric]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.metric === metric)));
    app!.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
    const known = rows.filter(model => view === "compare" ? model.c !== null && model.p !== null : metric === "newest" ? model.n !== null : score(model) !== null).length;
    count.textContent = `${known} ranked / ${rows.length} models`;
    title.textContent = view === "compare" ? "Intelligence × Popularity" : metric === "popularity" ? "Popularity" : metric === "capability" ? "Intelligence" : "Release date";
    context.textContent = view === "compare" ? `${profile?.name.replace(" — source headline", "") ?? "Intelligence"} · Weighted popularity` : metric === "popularity" ? pWindow : metric === "capability" ? profile?.name.replace(" — source headline", "") ?? "No observations" : "models.dev";
    if ((view === "compare" || metric === "capability") && profile) context.innerHTML = aaCredit(profile.name.replace(" — source headline", ""));
    more.hidden = view === "compare" || rows.length <= limit;
    if (!rows.length) results.innerHTML = '<p class="ranking-empty">No matching models</p>';
    else if (view === "table") renderTable(rows.slice(0, limit));
    else if (view === "compare") renderScatter(rows);
    else if (metric === "newest") renderTimeline(rows.slice(0, limit));
    else renderBars(rows.slice(0, limit));
    results.setAttribute("aria-busy", "false");
    saveUrl();
    if (schema && schemaElement && siteUrl) {
      const list = rankingStructuredList(siteUrl, rows, metric, view, limit);
      const index = schema["@graph"].findIndex(node => node["@id"] === list["@id"]);
      schema["@graph"][index] = list;
      schemaElement.textContent = serializeStructuredData(schema);
    }
  }
  function renderBars(rows: WebRankingModel[]) {
    const max = metric === "popularity" ? maxP : maxC;
    const ticks = [0, .25, .5, .75, 1];
    results.innerHTML = `<div class="ranking-bars"><div class="ranking-axis"><span>${metric === "popularity" ? "Weighted index" : "AA score"}</span><div>${ticks.map(tick => `<span style="left:${tick * 100}%">${number(tick * max)}</span>`).join("")}</div></div>${rows.map(model => {
      const value = score(model);
      return `<div class="ranking-bar-row">${modelLink(model)}<button type="button" class="ranking-bar-track" data-detail="${h(model.id)}" aria-label="${h(model.name)} ${metric} ${metricValue(model)}; view sources">${value === null ? '<span class="ranking-no-data">—</span>' : `<span class="ranking-bar" style="width:${value / max * 100}%"></span><span class="ranking-bar-value" style="left:${value / max * 100}%">${metricValue(model)}</span>`}</button></div>`;
    }).join("")}</div>`;
  }
  function renderTimeline(rows: WebRankingModel[]) {
    results.innerHTML = `<div class="ranking-timeline">${rows.map(model => `<div class="ranking-timeline-row"><button type="button" class="ranking-date" data-detail="${h(model.id)}">${h(releaseLabel(model))}</button><span class="ranking-timeline-dot" aria-hidden="true"></span>${modelLink(model)}<span class="ranking-lab-label">${h(model.lab_id)}</span></div>`).join("")}</div>`;
  }
  function renderTable(rows: WebRankingModel[]) {
    results.innerHTML = `<div class="ranking-table-wrap"><table class="ranking-table"><thead><tr><th>Model</th><th>Intelligence<small>${aaCredit()}</small></th><th>Popularity</th><th>Released</th><th>Price <a href="https://models.dev/models/" target="_blank" rel="noreferrer">models.dev ↗</a><small>Input / Output · $ / 1M tokens</small></th></tr></thead><tbody>${rows.map(model => `<tr><td>${modelLink(model)}</td><td><button data-detail="${h(model.id)}">${number(model.c, 1)}</button></td><td><button data-detail="${h(model.id)}">${number(model.p, 3)}</button></td><td>${h(releaseLabel(model))}</td><td class="ranking-price">${costSummary(model.price.input ?? undefined, model.price.output ?? undefined)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function renderScatter(rows: WebRankingModel[]) {
    const points = rows.filter(model => model.c !== null && model.p !== null);
    const mobile = matchMedia("(max-width: 720px)").matches;
    const width = mobile ? 380 : 960, height = mobile ? 370 : 470, left = mobile ? 36 : 60, top = 28, right = mobile ? 15 : 35, bottom = 54;
    const labeled = new Set([...points].sort((a, b) => b.c! - a.c!).slice(0, 1).concat([...points].sort((a, b) => b.p! - a.p!).slice(0, mobile ? 1 : 2)).map(model => model.id));
    const x = (p: number) => left + p / maxP * (width - left - right);
    const y = (c: number) => height - bottom - c / maxC * (height - top - bottom);
    results.innerHTML = `<div class="ranking-scatter"><svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Model intelligence versus weighted popularity"><g class="ranking-scatter-grid">${[0,.25,.5,.75,1].map(t => `<line x1="${x(t * maxP)}" y1="${top}" x2="${x(t * maxP)}" y2="${height - bottom}"/><line x1="${left}" y1="${y(t * maxC)}" x2="${width - right}" y2="${y(t * maxC)}"/><text x="${x(t * maxP)}" y="${height - bottom + 24}" text-anchor="middle">${number(t * maxP)}</text><text x="${left - 12}" y="${y(t * maxC) + 4}" text-anchor="end">${number(t * maxC)}</text>`).join("")}</g><text class="ranking-axis-label" x="${left}" y="16">Intelligence ↑</text><text class="ranking-axis-label" x="${width - right}" y="${height - 8}" text-anchor="end">Popularity →</text>${points.map(model => `<g class="ranking-point" data-detail="${h(model.id)}" role="button" tabindex="0" aria-label="${h(model.name)}, intelligence ${number(model.c, 1)}, popularity ${number(model.p, 3)}"><circle cx="${x(model.p!)}" cy="${y(model.c!)}" r="5"/><title>${h(model.name)} · C ${number(model.c, 1)} · P ${number(model.p, 3)}</title>${labeled.has(model.id) ? `<text x="${x(model.p!) + (model.p! > maxP * .72 ? -10 : 10)}" y="${y(model.c!) - 10}" text-anchor="${model.p! > maxP * .72 ? "end" : "start"}">${h(model.name)}</text>` : ""}</g>`).join("")}</svg><span class="ranking-scatter-count">${points.length} models · C + P</span></div>`;
    if (!points.length) results.innerHTML = '<p class="ranking-empty">No models with both intelligence and popularity data</p>';
  }
  function openDetail(id: string) {
    const model = models.get(id);
    if (!model) return;
    const c = model.capability, p = model.popularity, n = model.release;
    const weighted = p.state === "known" ? p.value.weighted : undefined;
    let configuration = c.state === "known" ? c.value.inference_config : "—";
    try { configuration = JSON.parse(configuration).configuration ?? configuration; } catch { /* Non-JSON configurations are already display text. */ }
    const sourceEntries = weighted ? Object.entries(weighted.sources).sort(([a], [b]) => ["openrouter", "vercel-ai-gateway", "opencode-go-free"].indexOf(a) - ["openrouter", "vercel-ai-gateway", "opencode-go-free"].indexOf(b)) : [];
    document.getElementById("ranking-detail-body")!.innerHTML = `<h2 id="ranking-detail-title">${h(model.name)}</h2><a href="${h(model.href)}">Model details ↗</a><dl class="ranking-facts"><div><dt>Intelligence</dt><dd>${number(model.c, 1)}</dd></div><div><dt>Popularity</dt><dd>${number(model.p, 3)}</dd></div><div><dt>Released</dt><dd>${h(releaseLabel(model))}</dd></div></dl>${c.state === "known" ? `<h3>${aaCredit()}</h3><dl class="ranking-source-facts"><dt>Index</dt><dd>${h(profile?.name.replace(" — source headline", "") ?? c.value.profile_id)}</dd><dt>Configuration</dt><dd>${h(configuration)}</dd><dt>Source date</dt><dd>${h(c.data_as_of ?? "—")}</dd><dt>Retrieved</dt><dd>${h(c.retrieved_at)}</dd></dl>` : `<p class="ranking-status">Intelligence · ${h(c.state)}</p>`}${weighted ? `<h3>Popularity sources</h3><table class="ranking-source-table"><thead><tr><th>Source</th><th>Weight</th><th>Days</th><th>Contribution</th></tr></thead><tbody>${sourceEntries.map(([id, evidence]) => `<tr><td>${h(({ openrouter: "OpenRouter", "vercel-ai-gateway": "Vercel", "opencode-go-free": "Go / Free" } as Record<string, string>)[id] ?? id)}</td><td>${number(evidence.weight * 100)}%</td><td>${evidence.observed_days}/${weighted.dates.length}</td><td>${number(evidence.contribution, 3)}</td></tr>`).join("")}</tbody></table><p class="ranking-status">${h(weighted.dates[0] ?? "")} — ${h(weighted.dates.at(-1) ?? "")} UTC</p>` : `<p class="ranking-status">Popularity · ${h(p.state)}</p>`}<h3>Release</h3><dl class="ranking-source-facts"><dt>Source</dt><dd>models.dev</dd><dt>Precision</dt><dd>${n.state === "known" ? h(n.value.precision) : h(n.state)}</dd></dl><h3>Price <a href="https://models.dev/models/" target="_blank" rel="noreferrer">models.dev ↗</a></h3><p class="ranking-detail-price">${costSummary(model.price.input ?? undefined, model.price.output ?? undefined)} <small>Input / Output · $ / 1M tokens</small></p>`;
    detail.showModal();
  }
  app!.querySelectorAll<HTMLButtonElement>("[data-metric]").forEach(button => button.addEventListener("click", () => { metric = button.dataset.metric as Metric; limit = 30; render(); }));
  app!.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => button.addEventListener("click", () => { view = button.dataset.view as View; limit = 30; render(); }));
  [search, lab, provider].forEach(input => input.addEventListener(input === search ? "input" : "change", () => { limit = 30; render(); }));
  more.addEventListener("click", () => { limit += 30; render(); });
  results.addEventListener("click", event => { const target = (event.target as Element).closest<HTMLElement>("[data-detail]"); if (target?.dataset.detail) openDetail(target.dataset.detail); });
  results.addEventListener("keydown", event => { const target = (event.target as Element).closest<HTMLElement>(".ranking-point"); if (target?.dataset.detail && ["Enter", " "].includes(event.key)) { event.preventDefault(); openDetail(target.dataset.detail); } });
  document.getElementById("ranking-detail-close")!.addEventListener("click", () => detail.close());
  detail.addEventListener("click", event => { if (event.target === detail) detail.close(); });
  window.addEventListener("resize", () => { if (view === "compare") render(); });
  render();
}

import { type Bundle } from "./types.js";

export type CoverageStatus = "supported" | "uncovered" | "authentication_required" | "no_public_source" | "unverified";
export type CoverageReport = { published_fact_count: number; inventory: { source: string; revision: string; provider_count: number; model_identity_count: number; coginework_inventory: null }; providers: { provider: string; identities: number; release_known: number; release_eligible: number; capability_known: number; popularity_known: number; popularity_eligible: number; status: { catalog: CoverageStatus; release: CoverageStatus; capability: CoverageStatus; popularity: CoverageStatus } }[]; source_gaps: { source: string; status: CoverageStatus; explanation: string }[] };

export function coverageReport(bundle: Bundle): CoverageReport {
  const ids = [...new Set(bundle.facts.map((fact) => fact.identity.provider))].sort();
  const providers = ids.map((provider) => {
    const facts = bundle.facts.filter((fact) => fact.identity.provider === provider);
    const release_known = facts.filter((fact) => fact.release.state === "known").length;
    const release_eligible = facts.filter((fact) => fact.release.state === "known" && fact.release.value.verified && fact.release.value.version_specific && fact.release.value.precision === "day" && fact.release.value.date <= bundle.published_at.slice(0, 10)).length;
    const capability_known = facts.filter((fact) => fact.capability.state === "known").length;
    const popularity_known = facts.filter((fact) => fact.popularity.state === "known").length;
    const popularity_eligible = facts.filter((fact) => fact.popularity.state === "known" && fact.popularity.value.ranking_eligible).length;
    return { provider, identities: facts.length, release_known, release_eligible, capability_known, popularity_known, popularity_eligible, status: { catalog: "supported" as const, release: release_eligible ? "supported" as const : release_known ? "unverified" as const : "uncovered" as const, capability: capability_known ? "supported" as const : "no_public_source" as const, popularity: popularity_eligible ? "supported" as const : provider === "openrouter" ? "unverified" as const : "uncovered" as const } };
  });
  return { published_fact_count: bundle.facts.length, inventory: { source: "Pinned models.dev provider catalog, not a CogineWork availability inventory", revision: bundle.source_revisions.find((source) => source.id === "models-dev")?.code_commit ?? "unknown", provider_count: ids.length, model_identity_count: bundle.facts.length, coginework_inventory: null }, providers, source_gaps: [ { source: "capability", status: "no_public_source", explanation: "No production capability source with confirmed metric comparability and public redistribution rights enabled; Artificial Analysis is a candidate only." }, { source: "openrouter-weekly", status: "unverified", explanation: "Documented weekly order collector exists; /models redistribution and per-item usage coverage require review. No inferred counts, share or population rank." }, { source: "openrouter-rankings-daily", status: "authentication_required", explanation: "Documented Data API dataset requires a key and covers daily top 50 plus aggregate other. It cannot be summed into a complete weekly ranking; no credential used." } ] };
}

export function coverageMarkdown(report: CoverageReport): string {
  return `# Provider / field coverage\n\nInventory: ${report.inventory.provider_count} providers, ${report.inventory.model_identity_count} scoped identities from upstream ${report.inventory.revision}. Public facts: ${report.published_fact_count} scoped identities. No CogineWork account inventory used.\n\nStatuses: supported, uncovered, authentication_required, no_public_source, unverified. A catalog entry is never account entitlement.\n\n| Provider | Identities | N eligible / raw known | C | P eligible / raw known | P status |\n| --- | ---: | ---: | --- | ---: | --- |\n${report.providers.map((p) => `| ${p.provider} | ${p.identities} | ${p.release_eligible} / ${p.release_known} | ${p.status.capability} | ${p.popularity_eligible} / ${p.popularity_known} | ${p.status.popularity} |`).join("\n")}\n\n${report.source_gaps.map((gap) => `- ${gap.source}: **${gap.status}** — ${gap.explanation}`).join("\n")}\n`;
}

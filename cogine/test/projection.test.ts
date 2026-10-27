import { describe, expect, test } from "bun:test";
import { filterIndex, matchFacts, project, trustedRelease } from "../src/projection.js";
import { PUBLIC_SCOPE, unknown, type Bundle, type Mapping, type ModelFacts } from "../src/types.js";
import { bundle, capability, identity, model, popularity, release, timestamp } from "./contract-fixture.js";

const options = { now: timestamp, provider_order: ["provider-a", "provider-b", "router"], profile_id: "fixture-profile", popularity_source_id: "fixture" };
const available = (models: ModelFacts[]) => models.map(m => ({ identity: m.identity, display_name: m.display_name, free: m.identity.request_model_id.endsWith(":free") }));
const ids = (models: { identity: { request_model_id: string } }[]) => models.map(m => m.identity.request_model_id);
const mapping = (from = identity("alias"), to = identity()): Mapping => ({ id: "reviewed-alias", from, to, fields: ["release"], evidence: "Official exact alias, this field only", reviewed_by: "maintainer", reviewed_at: timestamp, status: "approved" });

describe("exact field-scoped identity", () => {
  test("same display names, case, suffixes, versions and scope never guess identity", () => {
    const input = bundle({ facts: [model()] });
    for (const candidate of [identity("different-id"), identity("MODEL-v1"), identity("model-v1:free"), identity("model-v1:cloud"), identity("model-v2"), identity("model-v1-quantized"), identity("model-v1", "other-provider"), identity("model-v1", "provider-a", { ...PUBLIC_SCOPE, region: "eu" }), identity("model-v1", "provider-a", { ...PUBLIC_SCOPE, plan: "enterprise" }), identity("model-v1", "provider-a", { ...PUBLIC_SCOPE, protocol: "responses" })]) {
      expect(matchFacts(candidate, input, "release").status).toBe("unmatched");
    }
    expect(matchFacts(identity(), input, "release").status).toBe("matched");
  });
  test("canonical metadata does not inherit fields; reviewed alias applies only specified field", () => {
    const input = bundle({ facts: [model("model-v1", { canonical_id: "lab/model", capability: capability(99) })], mappings: [mapping()] });
    expect(matchFacts(identity("alias"), input, "release").status).toBe("matched");
    expect(matchFacts(identity("alias"), input, "capability").status).toBe("unmatched");
    const canonicalOnly = model("other-id", { canonical_id: "lab/model", release: unknown("Not verified for this route") });
    input.facts.push(canonicalOnly);
    expect(matchFacts(canonicalOnly.identity, input, "release").fact.state).toBe("unknown");
  });
  test("recorded conflict defeats exact match; multiple reviewed targets are ambiguous", () => {
    const input = bundle({ mappings: [{ ...mapping(identity()), status: "conflict" }] });
    expect(matchFacts(identity(), input, "release").status).toBe("conflict");
    input.facts.push(model("model-v2"));
    input.mappings = [mapping(), { ...mapping(identity("alias"), identity("model-v2")), id: "second" }];
    expect(matchFacts(identity("alias"), input, "release").status).toBe("ambiguous");
  });
});

describe("C/P/N total local indexes", () => {
  test("public facts never expand available membership, execution identity or local metadata", () => {
    const input = bundle({ facts: [model(), model("unavailable", { capability: capability(999) })] });
    const current = [{ identity: identity(), display_name: "Local name", execution_url: "https://private.invalid", account_local_metadata: "kept locally" }];
    const original = structuredClone(current);
    const output = project(current, input, options);
    for (const index of [output.capability, output.popularity, output.newest]) {
      expect(index).toHaveLength(1);
      expect(index[0]!.identity).toEqual(original[0]!.identity);
      expect(index[0]!.execution_url).toBe(original[0]!.execution_url);
      expect(index[0]!.account_local_metadata).toBe("kept locally");
    }
    expect(current).toEqual(original);
  });
  test("effective N uses source-trusted already occurred day dates and preserves unknown states", () => {
    for (const fact of [release("2026-10", { precision: "month" }), release("2027-01-01"), release("2026-01-01", { verified: false }), release("2026-01-01", { version_specific: false }), { state: "conflict" as const, reason: "Conflicting release evidence" }, { state: "withdrawn" as const, correction_id: "c", reason: "Bad date" }]) expect(trustedRelease(fact, timestamp)).toBeUndefined();
    const facts = [model("month", { release: release("2026-10", { precision: "month" }) }), model("older", { release: release("2025-01-01") }), model("newer", { release: release("2026-10-02") }), model("future", { release: release("2027-01-01") })];
    expect(ids(project(available(facts), bundle({ facts }), options).newest)).toEqual(["newer", "older", "month", "future"]);
  });
  test("unknown is not zero and incomparable profile/config is never mixed", () => {
    const facts = [model("unknown"), model("zero", { capability: capability(0) }), model("other-profile", { capability: capability(1000, "other-profile") }), model("wrong-config", { capability: capability(1000, "fixture-profile", "reasoning=high") })];
    const input = bundle({ facts });
    input.metric_profiles.push({ ...input.metric_profiles[0]!, id: "other-profile", method_version: "2" });
    expect(ids(project(available(facts), input, options).capability)[0]).toBe("zero");
    input.metric_profiles[0]!.direction = "lower";
    facts.push(model("negative", { capability: capability(-10) }));
    expect(ids(project(available(facts), input, options).capability)[0]).toBe("negative");
  });
  test("aggregate compares primary metric before Provider; router has no privilege", () => {
    const facts = [model("a", { identity: identity("a", "provider-a"), capability: capability(5), popularity: popularity(3) }), model("b", { identity: identity("b", "provider-b"), capability: capability(9), popularity: popularity(1) }), model("r", { identity: identity("r", "router"), capability: capability(1), popularity: popularity(9) })];
    const output = project(available(facts), bundle({ facts }), options);
    expect(ids(output.capability)).toEqual(["b", "a", "r"]);
    expect(ids(output.popularity)).toEqual(["b", "a", "r"]);
  });
  test("source order requires explicit per-item coverage; tail ordinal does not invent rank", () => {
    const facts = [model("tail", { popularity: popularity(1, "tail", false), release: release("2020-01-01") }), model("covered", { popularity: popularity(20) }), model("not-listed", { release: release("2026-10-03") })];
    const output = project(available(facts), bundle({ facts }), options);
    expect(ids(output.popularity)).toEqual(["covered", "not-listed", "tail"]);
    expect(facts[0]!.popularity).toMatchObject({ value: { position: 1, ranking_eligible: false } });
    expect(facts[2]!.popularity.state).toBe("unknown");
  });
  test("P ties and unknowns fall back through comparable C then N without inventing P", () => {
    const facts = [
      model("p-first", { popularity: popularity(1), capability: capability(0) }),
      model("p-tie-strong", { popularity: popularity(2), capability: capability(30), release: release("2020-01-01") }),
      model("p-tie-new", { popularity: popularity(2), capability: capability(10), release: release("2026-10-24") }),
      model("c-strong", { capability: capability(90), release: release("2020-01-01") }),
      model("c-new", { capability: capability(10), release: release("2026-10-24") }),
      model("c-zero", { capability: capability(0), release: release("2020-01-01") }),
      model("n-new", { release: release("2026-10-24") }),
      model("anonymous", { release: release("2025-10-17") }),
      model("month-only", { release: release("2026-10", { precision: "month" }) }),
      model("no-data", { release: unknown("No date") }),
    ];
    const input = bundle({ facts });
    const original = structuredClone(facts);
    const result = project(available(facts), input, options);
    expect(ids(result.popularity)).toEqual(facts.map(fact => fact.identity.request_model_id));
    expect(ids(project([...available(facts)].reverse(), input, options).popularity)).toEqual(ids(result.popularity));
    expect(ids(filterIndex(result.popularity, { query: "c-" }))).toEqual(["c-strong", "c-new", "c-zero"]);
    expect(facts).toEqual(original);
    expect(result.popularity.find(model => model.identity.request_model_id === "c-strong")!.public_facts.popularity.state).toBe("unknown");
    expect(result.explanations.popularity).toContain("可比较能力");
  });
  test("P fallback honors the selected C profile, configuration and direction", () => {
    const facts = [
      model("valid-zero", { capability: capability(0), release: release("2020-01-01") }),
      model("valid-ten", { capability: capability(10), release: release("2020-01-01") }),
      model("other-profile", { capability: capability(999, "other"), release: release("2026-10-23") }),
      model("other-config", { capability: capability(999, "fixture-profile", "reasoning=high"), release: release("2026-10-24") }),
    ];
    const input = bundle({ facts });
    expect(ids(project(available(facts), input, options).popularity)).toEqual(["valid-ten", "valid-zero", "other-config", "other-profile"]);
    input.metric_profiles[0]!.direction = "lower";
    expect(ids(project(available(facts), input, options).popularity)).toEqual(["valid-zero", "valid-ten", "other-config", "other-profile"]);
    expect(ids(project(available(facts), input, { ...options, profile_id: undefined }).popularity).slice(0, 2)).toEqual(["other-config", "other-profile"]);
  });
  test("ties are deterministic; fallback explains no evidence and filtering preserves total order", () => {
    const facts = [model("z:free"), model("a"), model("b:free")];
    const output = project(available(facts), bundle({ facts }), options);
    expect(ids(output.capability)).toEqual(["a", "b:free", "z:free"]);
    expect(ids(output.newest)).toEqual(["z:free", "a", "b:free"]);
    expect(output.explanations.capability).toContain("不是能力结论");
    expect(output.explanations.popularity).toContain("未上榜不等于零");
    expect(ids(filterIndex(output.capability, { free_only: true }))).toEqual(["b:free", "z:free"]);
    expect(ids(project([...available(facts)].reverse(), bundle({ facts }), options).capability)).toEqual(ids(output.capability));
  });
  test("pairwise C/P comparison is transitive across mixed providers and unknowns", () => {
    const facts = Array.from({ length: 8 }, (_, i) => model(`m${i}`, { identity: identity(`m${i}`, i % 2 ? "provider-a" : "provider-b"), capability: i % 3 ? capability(i % 2 ? 7 : 0) : unknown("No score"), popularity: i % 3 ? popularity(9 - i) : unknown("No rank"), release: release(`2026-10-0${1 + (i % 3)}`) }));
    const input = bundle({ facts });
    const context = available(facts);
    for (const mode of ["capability", "popularity"] as const) {
      const before = (a: typeof context[number], b: typeof context[number]) => project([a, b], input, options)[mode][0]!.identity.request_model_id === a.identity.request_model_id;
      for (const a of context) for (const b of context) for (const c of context) if (a !== b && b !== c && a !== c && before(a, b) && before(b, c)) expect(before(a, c)).toBe(true);
      expect(ids(project(context, input, options)[mode])).toEqual(ids(project([...context].reverse(), input, options)[mode]));
    }
  });
});

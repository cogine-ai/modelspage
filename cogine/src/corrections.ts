import { identityKey, unknown, type Correction, type Field, type ModelFacts } from "./types.js";
import { correctionSchema } from "./schema.js";
import { stableStringify } from "./integrity.js";

/** Every effective reviewed correction survives replacement, unless a higher field revision supersedes it. */
export function assertCorrectionContinuity(previous: Correction[], next: Correction[]): void {
  const latest = (records: Correction[]) => {
    const byField = new Map<string, Correction>();
    for (const record of records) {
      const key = `${identityKey(record.identity)}:${record.field}`;
      if ((byField.get(key)?.sequence ?? -1) < record.sequence) byField.set(key, record);
    }
    return byField;
  };
  const nextLatest = latest(next);
  const previousById = new Map(previous.map(record => [record.id, record]));
  for (const record of next) {
    const old = previousById.get(record.id);
    if (old && stableStringify(old) !== stableStringify(record)) throw new Error("Correction history cannot be rewritten; append a higher reviewed field sequence");
  }
  for (const [key, old] of latest(previous)) {
    const current = nextLatest.get(key);
    if (!current || current.sequence < old.sequence) throw new Error("Reviewed correction/withdrawal/conflict is missing; rebuild with the current correction ledger");
    if (current.sequence === old.sequence && stableStringify(current) !== stableStringify(old)) throw new Error("Correction history cannot be rewritten; append a higher reviewed field sequence");
  }
}

/** Field-scoped, reviewed corrections dominate upstream regardless of download time. */
export function applyCorrections(facts: ModelFacts[], corrections: Correction[]): ModelFacts[] {
  const result = new Map(facts.map(x => [identityKey(x.identity), structuredClone(x)]));
  const seen = new Set<string>();
  for (const correction of [...corrections].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))) {
    correctionSchema.parse(correction);
    const key = identityKey(correction.identity);
    const version = `${key}:${correction.field}:${correction.sequence}`;
    if (seen.has(version)) throw new Error("Conflicting corrections have the same field sequence");
    seen.add(version);
    let model = result.get(key);
    if (!model) {
      model = { identity: correction.identity, display_name: correction.identity.request_model_id, release: unknown("No upstream fact"), capability: unknown("No upstream fact"), popularity: unknown("No upstream fact") };
      result.set(key, model);
    }
    const field: Field = correction.field;
    if (correction.action === "replace") (model as any)[field] = structuredClone(correction.value);
    else if (correction.action === "withdraw") (model as any)[field] = { state: "withdrawn", correction_id: correction.id, reason: correction.reason };
    else (model as any)[field] = { state: "conflict", reason: correction.reason };
  }
  return [...result.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, model]) => model);
}

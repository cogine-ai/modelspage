import { stableStringify } from "../src/integrity.ts";
import type { WebRankingDataset } from "./data.ts";
import { validateWebRankingDataset } from "./schema.ts";

export function selectPublishedDataset(candidate: WebRankingDataset, previous?: WebRankingDataset): WebRankingDataset {
  validateWebRankingDataset(candidate);
  if (!previous) return candidate;
  validateWebRankingDataset(previous);
  if (previous.audience !== "public") throw new Error("A local preview cannot seed the public website");
  const content = ({ revision: _revision, published_at: _publication, evaluated_at: _evaluation, ...data }: WebRankingDataset) => stableStringify(data);
  // A website/code-only deployment does not manufacture a new data revision or time.
  return content(candidate) === content(previous) ? previous : candidate;
}

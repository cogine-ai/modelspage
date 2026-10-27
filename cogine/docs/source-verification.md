# Source verification, 2026-10-26 (historical baseline)

2026-10-27 update: C/P collection and a fixed encrypted daily cohort are now implemented. The default builder consumes AA and multisource P alongside the pinned model catalog/N. See [daily integration](2026-10-27-daily-cpn-integration.md) for actual new validation, rights and activation status; zero-C/P statements below describe the earlier baseline.

The build uses the models.dev Git/catalog commit in `cogine/upstream.lock.json` and reuses `generateV2`. It does not fetch a separate models.dev API snapshot. The MIT LICENSE and copyright are retained. The project directly trusts the upstream parser's resolved `release_date`, including upstream base-model inheritance and alias records. Dates preserve upstream precision and do not require an independent local per-model review. `cogine/config/release-verifications.json` now provides optional supplementary evidence; corrections and withdrawals remain explicit.

Three initial supplementary reviews cover dated Anthropic Messages identities. [Sonnet 4.5](https://www.anthropic.com/news/claude-sonnet-4-5) was released 2025-09-29, [Haiku 4.5](https://www.anthropic.com/news/claude-haiku-4-5) on 2025-10-15, and [Opus 4.5](https://www.anthropic.com/news/claude-opus-4-5) on 2025-11-24. The Opus announcement explicitly names `claude-opus-4-5-20251101`: its ID suffix is not its public release date. These reviews no longer form an eligibility whitelist; other upstream records are trusted as maintained by models.dev.

## OpenRouter public weekly order

The [official Models API contract](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) documents `most-popular` and `top-weekly` for recent weekly token order, `output_modalities=all`, offset/limit pagination, `total_count`, and terminal `links.next`. The adapter implements these pagination rules and rejects incomplete, duplicate, empty or changing-total results. Position is the ordinal in one snapshot, with no fabricated counts or market share. Request `created` timestamps never become N dates.

A real unauthenticated read-only probe was executed at **2026-10-25T18:04:28.492Z** (2026-10-26 02:04:28.492 Asia/Singapore):

```text
GET https://openrouter.ai/api/v1/models?sort=top-weekly&output_modalities=all&limit=1000&offset=0
HTTP 200; application/json
received=691; total_count=691; pages=1; links.next=null
SHA-256=afa9ca96b67bc94fc567935ea07d9e6986672590f9751d778326d5ed8316b1a4
```

The exact sanitized result is `openrouter-probe.json`. Raw response bytes and transient collector state remain in ignored `.sync/`; no raw model response is committed or distributed. Completeness was verified for the returned catalog scope. No per-item weekly coverage flag, usage count, statistical window boundary or `data_as_of` was supplied by this response. The adapter retains those times as unknown and sets zero live entries eligible for P until the applicability/coverage is reviewed. Source position is retained internally without claiming precise tail popularity ranks.

`most-popular` was reviewed in the official contract; this live probe exercised `top-weekly`. No inference request, account-private model catalog or authenticated API was called.

## Rights and disabled sources

The [Data API license](https://openrouter.ai/docs/cookbook/administration/data-api) permits redistribution of its named dataset outputs with CC BY 4.0 attribution. It does not grant that license to `/models` or the entire website. Its authenticated `rankings-daily` dataset has daily top-50 rows and aggregate `other`; summing these would not establish a complete weekly ranking. That adapter is not enabled, and no authentication was attempted.

The [OpenRouter Terms](https://openrouter.ai/terms) also contain restrictions on automated copying. The initial `/models` collector remains disabled and both collection and redistribution permissions remain `unverified`, pending endpoint-specific authorization review. The explicit diagnostic probe does not change this configuration and is not a production input. After permission and per-item applicability are confirmed, maintainers must review the configuration and a complete persisted source snapshot in a PR. Daily disabled/unchanged/failed/partial attempts only update operational reports and never overwrite durable last-good data.

Artificial Analysis remains a candidate capability source, with no licensed production scores, no enabled production profile and no inference call. Arena preference is not treated as general capability. C therefore remains unknown.

## Coverage baseline

At pinned upstream commit `4f1231e6bf72d5fa66dc1163599eaaedb607faab`, a real offline catalog build using the corrected trust policy processed **230 providers and 11,960 scoped protocol identities**. All 11,960 have upstream dates: **11,855 day-precision N-eligible identities** and **105 month-precision identities**, with no future dates at the fixed build clock `2026-10-26T00:00:00.000Z`. There are still **0 C facts** and **0 P facts** in the default production dataset. The current sparse bundle publishes the day-precision facts plus explicit metrics, mapping or correction identities; the month-precision publication/sort policy remains a separate scope decision, not missing source data. Fixtures remain dense for precision/unknown tests. An absent public fact means unknown evidence, never account unavailability or retirement.

The generated coverage report records both the dense source inventory and `published_fact_count`. These counts describe this pinned public catalog, not CogineWork account availability. Run the documented build/coverage command to regenerate `dist/<output>/reports/coverage.json` and `coverage.md`; no permanent provider count is encoded in code.

## 2026-10-27 source-use review

[AA API documentation](https://artificialanalysis.ai/data-api/docs) describes internal API use and commercial integrations. [Data Platform Terms v1.1, §§2.3–2.5](https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf) separately restrict structured external distribution and third-party ranking/model-selection products without specific written consent. An API key is not evidence of those rights. The current project records no such permission; scores stay in authenticated encrypted review inputs and local builds, and the publisher rejects public distribution.

[OpenCode Data](https://opencode.ai/data) requests source/update-time citation; that is not a bulk machine-readable redistribution grant. Its [general terms](https://opencode.ai/legal/terms-of-service) also restrict extraction. Collection remains explicitly requested internal diagnostic use with unverified permission, and public redistribution remains unverified. Source code MIT does not replace data-use terms.

The [OpenRouter Data API](https://openrouter.ai/docs/cookbook/administration/data-api) explicitly licenses its dataset outputs CC BY 4.0. Vercel leaderboard data retains source attribution. Identity catalogs are separate endpoints and are not automatically granted the dataset's rights. Current field-specific authority is in `cogine/config/rank-sources.json`, applied before last-good comparison and again at build time.

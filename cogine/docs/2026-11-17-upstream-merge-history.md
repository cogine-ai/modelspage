# Upstream merge history repair — 2026-11-17

PR #37 used squash merge. Its catalog tree matched fixed upstream 157e5b612ac14820a1fcbb4ec1167cd606089db8, but that commit was not retained as an ancestor of main. The next sync therefore used older cf1019f99b26250a12576ee9fffb8672b45104bb as the merge base and conflicted on already synchronized upstream edits.

## Resolution

- Merge upstream dev at d17490d9ce20ec325ac4b78b27822ab548e56419 with a real two-parent merge commit.
- Since models/, providers/, labs/ and packages/core/ had no local difference from the previous pin, resolve those paths to the exact new upstream tree. Preserve local README.md, AGENTS.md, executable workflows and cogine/ implementation. Keep upstream workflow copies inert.
- Include the authenticated encrypted collection from successful collect job in run 44002620371, evaluation day 2026-11-17. No source credentials or plaintext snapshots are committed.
- Regenerate catalog-legacy.schema.json for upstream family enum addition qwen4-max.

## Required merge method

For every PR carrying upstream sync history, use **Create a merge commit**, or `gh pr merge --merge --match-head-commit <reviewed-head>`. Do not use squash or rebase merge. These strategies drop the upstream parent relationship even when all catalog files match.

Before merging, check `git merge-base --is-ancestor <pinned-upstream> <pr-head>`. After merging, repeat against the current remote main. Keep this history when resolving future sync conflicts; do not replace it with a content-only squash.

## Verification

- Fixed upstream catalog and parser paths are identical; local workflows and README are unchanged.
- Typechecks, generated schema check, catalog validation and v1 compatibility against the exact pin pass.
- Project suite: 242 pass. Additional six-file upstream suite: 385 pass, 8 fail; the exact same 8 failures reproduce on pristine upstream d17490d with the same runtime. They are upstream test/data assumptions, not introduced by this resolution. The focused changed-adapter suites are checked separately.
- Actual encrypted-input full bundle builds and passes schema/hash/size plus transition checks against active release 22. Website builds from that bundle.
- Candidate website: 643 canonical models; C/P/N counts 46/50/641. Three new v1 models: Qwen4 Max, Hy4 Flash, Particle-1. Muse Video is upstream v2_only and remains outside v1. Existing C scores and N dates do not regress; Muse Wonder Full gains AA v5 source headline 50.1, Qwen4 Max has 42.9. Missing observations stay unknown.

Production publication and all three domain readbacks must be checked after the authorized PR merge; local candidate validation alone is not deployment verification.

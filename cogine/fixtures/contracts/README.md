# Public contract examples

`valid-catalog.json` and `valid-manifest.json` form one hash-verified release. Every score, source and model is synthetic (`fixture: true`) and must never be published as production facts.

The negative examples separately demonstrate a request tracing ID used instead of an actual model ID, an ambiguous null field state, and an incompatible schema version. Runtime contract tests reject each example. JSON Schema describes the structural contract; `validateBundle` and `validateManifest` additionally check source/profile references, correction consistency, uniqueness and revision paths.

The normal end-to-end fixture build uses the sibling upstream/OpenRouter fixtures and independently constructs a release in `dist/fixture`.

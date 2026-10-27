# Public contract examples

`valid-catalog.json` and `valid-manifest.json` form one hash-verified release. Every score, source and model is synthetic (`fixture: true`) and must never be published as production facts.

The negative examples separately demonstrate a request tracing ID used instead of an actual model ID, an ambiguous null field state, and an incompatible schema version. Runtime contract tests reject each example. JSON Schema describes the structural contract; `validateBundle` and `validateManifest` additionally check source/profile references, correction consistency, uniqueness and revision paths.

The normal end-to-end fixture build uses the sibling upstream/OpenRouter fixtures and independently constructs a release in `dist/fixture`.

`valid-catalog-v2.json` and `valid-manifest-v2.json` add the weighted observed union, explicit UTC window/weights, known zero and null daily evidence. Catalog v2 requires projection/consumer 2.0; the manifest transport and immutable revision paths remain v1. New consumers continue reading v1 catalogs. `invalid-weighted-evidence-v2.json` has a score that contradicts its daily evidence and is rejected by semantic validation. All examples are synthetic.

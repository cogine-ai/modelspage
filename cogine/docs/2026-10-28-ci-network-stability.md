# CI public-origin reads and daily publication

## Incident and evidence

Production run [40636093116](https://github.com/cogine-ai/modelspage/actions/runs/40636093116)
failed twice during `production.ts prepare`, after roughly 34 seconds including setup.
Both failures reported only `The operation timed out.`. They occurred before building or
uploading a candidate. Changing the readback origin from `models.cogine.ai` to
`models.cogine.app` coincided with the third attempt succeeding; the historical logs do
not identify the request URL or whether headers or the body stalled.

The independent GitHub Ubuntu runner diagnostic
[40639745289](https://github.com/cogine-ai/modelspage/actions/runs/40639745289)
compared native DNS, address families, TLS, Bun/curl, cross-resolved IPv4 addresses
with the original Host/SNI, and Brotli/gzip/identity reads. All three public hosts
resolved to `modelspage.pages.dev` and the same A/AAAA address sets. All default and
IPv4 requests passed. The two Bun catalog reads took 1.195/0.785 seconds for `.ai`
and 1.813/1.730 seconds for `.app`; all catalog bodies were 36,050,111 bytes with
SHA256 `b82f971d64a13a6de4d622e6c3f5c3d45d42e19937c97bbc777a6e65211d6b81`.
All six forced-IPv6 probes failed immediately before TCP/TLS, for every host.
That runner's IPv6 path does not explain a domain-specific 30-second failure.

There is no reproduced `.ai`-specific DNS, certificate, IP or compression defect.
The exact transport cause of the historical timeout remains undetermined. A domain
switch is not evidence of a root-cause repair. Local DNS is intercepted by the
operator's Fake-IP network, so local DNS/curl results cannot substitute for runner
evidence.

## Narrow reliability change

Active-release seeding, public publication verification, and Pages' previous-ranking
read now share bounded transport reads: at most three attempts, 30 seconds per
attempt including the complete body, and capped backoff for transient network errors,
HTTP 408/429/5xx. Failed response bodies are cancelled before retrying. Log events
identify the sanitized origin/path, headers/body phase, attempt, elapsed time and
safe error name/code. No credentials, query strings or raw response bodies are logged.

JSON/schema/hash/size/metadata validation stays outside the transport retry. Only an
explicit manifest or previous-ranking 404 permits initial publication. Bad content
and missing catalogs still fail, and immutable objects plus conditional manifest
publication retain their existing checks. There is no catalog size cap borrowed from
the smaller source-JSON reader, no automatic domain fallback, and no change to C/P/N.

To repeat the credential-free runner diagnostic, dispatch **Modelspage PR validation**
with `network_diagnostic=true`. This runs transport comparisons and the actual
`production.ts prepare` command against `.ai` and `.app`; it does not upload or publish
anything and does not replace the regular validation job. Reports are retained as the
`public-origin-network-diagnostic` artifact for seven days.

## Validation

The active-release call-site regression tests reproduced missing recovery for both a
manifest timeout and a timed-out HTTP 200 catalog body, plus single-attempt HTTP 503
failure. They pass with the shared transport reader. Additional tests cover body
deadlines/cancellation, exhausted error context, terminal authentication/404 errors,
capped Retry-After, catalogs above 32 MiB, and terminal integrity failures.

Live workflow and publication results are recorded after the corresponding runs
complete; a successful diagnostic alone is not a daily-update or publication pass.

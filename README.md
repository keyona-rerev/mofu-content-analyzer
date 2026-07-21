# mofu-content-analyzer

T029 — MOFU Content Analyzer. Renders a target site with headless Chromium (background function), scores its content against the five-job content-capsule framework, results via Netlify Blobs + polling.

Gotchas learned the hard way (2026-07-21):
- Functions use Netlify's Lambda-compatibility API (`exports.handler`), where Netlify Blobs is NOT auto-configured — `connectLambda(event)` must be called before `getStore()` or everything dies with `MissingBlobsEnvironmentError`.
- `@sparticuz/chromium` must be v149+ here: Netlify functions run `nodejs24.x` (Amazon Linux 2023), and older chromium versions (v129 and earlier) misdetect that runtime as AL2 and extract the wrong shared libraries, failing with `libnspr4.so: cannot open shared object file`. Keep `puppeteer-core` paired to the chromium version (v149 ↔ puppeteer-core ^25.0.4).
- `netlify.toml` must keep `external_node_modules = ["puppeteer-core", "@sparticuz/chromium"]` — chromium's binaries break if esbuild bundles them.

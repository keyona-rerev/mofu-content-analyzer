# mofu-content-analyzer

T029 — MOFU Content Analyzer. Renders a target site with headless Chromium (background function), scores its content against the five-job content-capsule framework, results via Netlify Blobs + polling.

Note: `AWS_LAMBDA_JS_RUNTIME=nodejs20.x` must be set as a Netlify env var (functions scope) — @sparticuz/chromium reads it at import time to select AL2023-compatible shared libraries. Without it, Chromium fails with `libnspr4.so: cannot open shared object file`.

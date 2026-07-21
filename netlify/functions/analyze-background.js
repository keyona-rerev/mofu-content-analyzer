// Netlify BACKGROUND Function: POST /api/analyze-background
// T029 — MOFU Content Analyzer, v2 crawl engine.
//
// WHY THIS FILE EXISTS: the v1 engine (analyze.js) did a plain fetch() and
// never executed JavaScript, so any client-rendered site (React/Vue SPA with
// no prerendering — e.g. rerev.io) crawled as an empty shell every time. This
// version launches real headless Chromium, renders each page, and reads the
// DOM after JavaScript has run — same as what Google's own renderer or a
// human browser sees, not what a bare HTTP fetch sees.
//
// WHY IT'S A "-BACKGROUND" FUNCTION: rendering N pages in a real browser is
// seconds each (browser cold start alone is 2-5s), which blows past a normal
// synchronous function's response window. Background functions get a 15-
// minute budget instead of ~10-26s, at the cost of not returning a response
// directly — the caller gets a 202 immediately, and the actual result has to
// be picked up separately. That's what analyze-status.js is for: this
// function writes its result to Netlify Blobs when done, and the front end
// polls analyze-status.js with the job id until it's there.
//
// FLOW: index.html generates a job id -> POSTs {url, jobId} to
// /api/analyze-background (this file, returns 202 immediately, keeps running)
// -> this function renders pages, classifies with Claude, writes the result
// to Blobs under that job id -> index.html polls /api/analyze-status?id=...
// until status is "done" or "error".

const { connectLambda, getStore } = require('@netlify/blobs');

// @sparticuz/chromium v149+ and puppeteer-core v25+ are ESM-ONLY packages —
// a top-level require() of them crashes this CJS function at cold start,
// BEFORE the handler runs, so no error can ever be written to Blobs and the
// client polls "pending" forever. Dynamic import() from CJS is supported, so
// they're loaded lazily inside the handler instead. (Learned live 2026-07-21.)
let chromium = null;
let puppeteer = null;
async function loadBrowserDeps() {
  if (!chromium) {
    const chromiumMod = await import('@sparticuz/chromium');
    chromium = chromiumMod.default ?? chromiumMod;
    const puppeteerMod = await import('puppeteer-core');
    puppeteer = puppeteerMod.default ?? puppeteerMod;
  }
}

const MAX_PAGES = 18;
const NAV_TIMEOUT_MS = 20000; // per-page render budget — generous since we're in a 15-min function now
const CONCURRENCY = 3; // parallel browser tabs; kept modest for memory headroom in the function's container
const MAX_CHARS_PER_PAGE = 2200;

const JOB_ORDER = ['symptom', 'solution', 'value', 'proof', 'product'];

const JOB_DEF = {
  symptom: {
    label: 'Symptom Awareness',
    job: "Make an invisible cost visible, before anyone's gone looking for a fix. Written for a reader who doesn't yet know they have a problem — names the hidden cost of the status quo (time, money, risk) without pitching the product.",
  },
  solution: {
    label: 'Solution Education',
    job: "Teach how to shop for a fix at all, before you're in the running. For a reader who knows something's broken and is comparing approaches — lays out options with real tradeoffs, not a single vendor's process.",
  },
  value: {
    label: 'Value Proposition',
    job: "Make the case for why it's you, specifically — not just why help in general. States the product, the outcome, and (ideally) why that beats a named alternative or category.",
  },
  proof: {
    label: 'Customer & Data Stories',
    job: 'Let someone else say it worked, with a number attached. Requires a named customer, a direct quote, or attributed data — an aggregate/self-reported stat with no attribution does NOT count.',
  },
  product: {
    label: 'Product Deep Dive',
    job: "Help someone who's already sold picture using it on day one. Workflow depth, mechanics, named use cases, demos — not persuasion.",
  },
};

const MIN_PER_JOB = 3;

const BLOCK_PATH = /\/(login|signin|signup|terms|privacy|cookie-policy|cart|checkout)(\/|$|\?)/i;
const INDEX_HINT = /\/(blog|resources|insights|articles|content|news|case-studies|guides|learn)(\/|$|\?)/i;
const ASSET_EXT = /\.(css|js|mjs|json|xml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|pdf|zip|mp4|mp3|wav|avif)$/i;

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function filterLinks(rawHrefs, baseUrl, hostname) {
  const links = new Set();
  for (const href of rawHrefs) {
    const abs = normalizeUrl(href, baseUrl);
    if (!abs) continue;
    try {
      const u = new URL(abs);
      if (u.hostname.replace(/^www\./, '') !== hostname.replace(/^www\./, '')) continue;
      if (BLOCK_PATH.test(u.pathname)) continue;
      if (ASSET_EXT.test(u.pathname)) continue;
      links.add(abs);
    } catch { /* skip */ }
  }
  return links;
}

async function launchBrowser() {
  await loadBrowserDeps();
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

// Renders one URL in a fresh tab: real JS execution, then reads the DOM
// after render (document.body.innerText, real <a> hrefs from the live DOM,
// not a regex against serialized markup) — this is the entire point of v2.
async function renderPage(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (compatible; MOFUContentAnalyzer/2.0; +headless-render)');
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      // Skip loading images/fonts/media — we only need text + link structure,
      // and this meaningfully speeds up render time per page.
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') req.abort();
      else req.continue();
    });
    const bustUrl = url + (url.includes('?') ? '&' : '?') + '_cb=' + Date.now();
    await page.goto(bustUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    const title = await page.title();
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '').trim());
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    return { ok: true, title, text: text.slice(0, MAX_CHARS_PER_PAGE), hrefs };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function crawl(seedUrl) {
  const seed = normalizeUrl(seedUrl, seedUrl);
  const hostname = new URL(seed).hostname;
  const browser = await launchBrowser();

  try {
    const seedRender = await renderPage(browser, seed);
    if (!seedRender.ok) throw new Error(`Could not render ${seed}: ${seedRender.error}`);

    const candidateLinks = filterLinks(seedRender.hrefs, seed, hostname);

    const homeUrl = normalizeUrl(new URL(seed).origin, seed);
    let homeRender = null;
    if (homeUrl && homeUrl !== seed) {
      homeRender = await renderPage(browser, homeUrl);
      if (homeRender.ok) filterLinks(homeRender.hrefs, homeUrl, hostname).forEach((l) => candidateLinks.add(l));
    }

    // Expand any index-like page (e.g. /blog) one level to pick up individual posts.
    const indexLike = [...candidateLinks].filter((l) => INDEX_HINT.test(new URL(l).pathname)).slice(0, 5);
    const expandResults = await mapWithConcurrency(indexLike, CONCURRENCY, (l) => renderPage(browser, l));
    expandResults.forEach((res, i) => {
      if (res.ok) filterLinks(res.hrefs, indexLike[i], hostname).forEach((l) => candidateLinks.add(l));
    });

    candidateLinks.add(seed);
    if (homeUrl) candidateLinks.add(homeUrl);

    const pageUrls = [...candidateLinks].slice(0, MAX_PAGES);

    // Reuse the seed/home renders we already did instead of re-rendering them.
    const already = new Map();
    already.set(seed, seedRender);
    if (homeUrl && homeRender) already.set(homeUrl, homeRender);

    const renders = await mapWithConcurrency(pageUrls, CONCURRENCY, async (u) => {
      if (already.has(u)) return already.get(u);
      return renderPage(browser, u);
    });

    const pages = [];
    const skipped = [];
    renders.forEach((res, i) => {
      if (res.ok && res.text && res.text.length > 200) {
        pages.push({ url: pageUrls[i], title: res.title || pageUrls[i], text: res.text });
      } else if (res.ok) {
        skipped.push({ url: pageUrls[i], title: res.title || pageUrls[i], reason: 'empty_after_render' });
      } else {
        skipped.push({ url: pageUrls[i], title: pageUrls[i], reason: 'render_failed', detail: res.error });
      }
    });

    return { pages, skipped, urls_found: pageUrls.length };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- Claude classification (identical rubric to v1) ----------

function buildPrompt(pages) {
  const jobLines = JOB_ORDER.map((k) => `- ${k} (${JOB_DEF[k].label}): ${JOB_DEF[k].job}`).join('\n');
  const pageBlocks = pages
    .map((p, i) => `PAGE ${i + 1}\nURL: ${p.url}\nTITLE: ${p.title}\nTEXT:\n${p.text}\n`)
    .join('\n---\n');

  return `You are auditing a company's owned content (site pages, blog posts) against a five-job "content capsule" framework used for MOFU (mid-funnel) B2B content strategy. Infer the target buyer/ICP yourself from what the site sells — no separate audience definition is provided.

THE FIVE JOBS:
${jobLines}

RULES:
- Classify each page into exactly ONE best-fit job, OR mark it "unmatched" if it doesn't do any of the five jobs well enough to count — e.g. content that is mostly industry/market news about OTHER companies with only a token mention of this company's product does not count toward any job, even if loosely on-topic.
- Do not force-fit a borderline page into a job just to inflate its count. A weak/loose fit still counts (mark fit "loose"), but a page that isn't meaningfully doing the job at all goes to unmatched with a one-sentence reason.
- Flag "split_focus": true on any piece that does its assigned job well for most of its length but then breaks discipline with an unearned product pitch in the close (e.g. an educational piece that suddenly says "this is the problem X was built to solve" or drops a demo-request CTA). Note this in the piece's one-line note.
- Flag near-duplicate pieces (two pieces that share the same structure/template and could not function as genuinely separate pieces toward the 3-piece minimum) by giving them matching "duplicate_group" values (e.g. "dup-1") — omit this field entirely for pieces with no duplicate.
- For each job, score 0-100 using these subweights: presence+count (0-40, scaled by how close the piece count is to a 3-piece minimum — pieces in the same duplicate_group only count as ONE toward this), audience fit (0-30, how well matched to the inferred buyer), job completion (0-30, does the content actually accomplish what the job needs, quote-worthy specifics over vague gestures — dock split_focus pieces here).
- A job with 0 pieces scores low (roughly 0-15) even if you're being generous elsewhere — do not round up out of politeness.
- composite_score is the plain average of the five job scores, rounded to the nearest whole number.

PAGES CRAWLED (${pages.length} total):
${pageBlocks}

Return ONLY a JSON object, no markdown fences, no preamble, exactly this shape:
{
  "composite_score": 41,
  "jobs": {
    "symptom": {"score": 65, "diagnosis": "1-3 sentences on what's working and what's missing, plain prose", "pieces": [{"url": "...", "title": "...", "fit": "strong|loose", "note": "1 short sentence on this specific piece", "split_focus": false, "duplicate_group": null}]},
    "solution": {"score": 0, "diagnosis": "...", "pieces": []},
    "value": {"score": 0, "diagnosis": "...", "pieces": []},
    "proof": {"score": 0, "diagnosis": "...", "pieces": []},
    "product": {"score": 0, "diagnosis": "...", "pieces": []}
  },
  "unmatched": [{"url": "...", "title": "...", "reason": "1 sentence on why this doesn't count toward any job", "duplicate_group": null}]
}
Every page you were given must appear exactly once, either inside one job's "pieces" array or inside "unmatched". Keep diagnosis strings under 500 characters, note/reason strings under 200 characters. No citation markers, brackets, or markdown inside any string.`;
}

function clampScore(n) {
  const x = parseInt(n, 10);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

function sanitizeStr(s, max) {
  return String(s == null ? '' : s)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function classify(pages) {
  const { ANTHROPIC_API_KEY } = process.env;
  if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY.');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3200,
      temperature: 0,
      messages: [{ role: 'user', content: buildPrompt(pages) }],
    }),
  });
  const data = await r.json();
  if (!r.ok || data.error) {
    const detail = data && data.error ? (data.error.message || data.error.type || 'api_error') : `http_${r.status}`;
    throw new Error(`Anthropic API error: ${detail}`);
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON found in Claude response.');
  return JSON.parse(m[0]);
}

exports.handler = async (event) => {
  // Blobs is NOT auto-configured for Lambda-compatibility (exports.handler)
  // functions — connectLambda(event) must run before getStore, or the whole
  // handler dies with MissingBlobsEnvironmentError before it can write
  // anything, leaving the client polling forever. (Confirmed live 2026-07-21.)
  connectLambda(event);
  const store = getStore('mofu-analyzer-jobs');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Bad request.' }; }

  const jobId = String(body.jobId || '').trim();
  const rawUrl = String(body.url || '').trim();
  if (!jobId || !rawUrl) return { statusCode: 400, body: 'Missing jobId or url.' };

  // From here on, always write SOME terminal state to the blob store, even on
  // failure — the client is polling and needs an answer, not silence.
  try {
    let seedUrl;
    try {
      seedUrl = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).href;
    } catch {
      await store.setJSON(jobId, { status: 'error', error: 'That does not look like a valid URL.' });
      return { statusCode: 200 };
    }

    const { pages, skipped, urls_found } = await crawl(seedUrl);

    if (!pages.length) {
      await store.setJSON(jobId, {
        status: 'error',
        error: 'Rendered the site but found no readable content pages.',
        urls_found,
        skipped: skipped.slice(0, 20),
      });
      return { statusCode: 200 };
    }

    const parsed = await classify(pages);
    if (!parsed.jobs || typeof parsed.jobs !== 'object') {
      await store.setJSON(jobId, { status: 'error', error: 'The analysis came back in an unexpected shape.' });
      return { statusCode: 200 };
    }

    const clean = {
      urls_found,
      pages_crawled: pages.length,
      pages_skipped: skipped.length,
      source_url: seedUrl,
      jobs: {},
      unmatched: [],
      page_inventory: [],
    };

    JOB_ORDER.forEach((key) => {
      const j = parsed.jobs[key] || {};
      const pieces = Array.isArray(j.pieces) ? j.pieces.slice(0, 20).map((p) => ({
        url: sanitizeStr(p.url, 300),
        title: sanitizeStr(p.title, 140),
        fit: p.fit === 'strong' ? 'strong' : 'loose',
        note: sanitizeStr(p.note, 200),
        split_focus: p.split_focus === true,
        duplicate_group: p.duplicate_group ? sanitizeStr(p.duplicate_group, 30) : null,
      })) : [];
      clean.jobs[key] = {
        label: JOB_DEF[key].label,
        job: JOB_DEF[key].job,
        score: clampScore(j.score),
        count: pieces.length,
        min_met: pieces.length >= MIN_PER_JOB,
        diagnosis: sanitizeStr(j.diagnosis, 500),
        pieces,
      };
      pieces.forEach((p) => {
        clean.page_inventory.push({
          url: p.url, title: p.title, assigned_job: JOB_DEF[key].label,
          fit: p.fit, note: p.note, split_focus: p.split_focus, duplicate_group: p.duplicate_group,
        });
      });
    });

    clean.unmatched = Array.isArray(parsed.unmatched) ? parsed.unmatched.slice(0, 30).map((u) => ({
      url: sanitizeStr(u.url, 300),
      title: sanitizeStr(u.title, 140),
      reason: sanitizeStr(u.reason, 200),
      duplicate_group: u.duplicate_group ? sanitizeStr(u.duplicate_group, 30) : null,
    })) : [];
    clean.unmatched.forEach((u) => {
      clean.page_inventory.push({
        url: u.url, title: u.title, assigned_job: 'Unmatched',
        fit: null, note: u.reason, split_focus: false, duplicate_group: u.duplicate_group,
      });
    });

    const scores = JOB_ORDER.map((k) => clean.jobs[k].score);
    clean.composite_score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    await store.setJSON(jobId, { status: 'done', ...clean });
  } catch (e) {
    try {
      await store.setJSON(jobId, { status: 'error', error: String((e && e.message) || e).slice(0, 300) });
    } catch { /* if even writing the error fails, the client's poll will eventually time out with its own message */ }
  }

  return { statusCode: 200 };
};

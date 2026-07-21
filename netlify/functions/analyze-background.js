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
// TWO-STAGE ANALYSIS (added 2026-07-21):
//   Stage 1 — read the site's CORE pages (home, services, about) and write an
//   explicit business profile: the problem solved, how, and for whom — held
//   to the definition "a business solves a problem for a qualified audience."
//   Stage 2 — score the CONTENT pages against that profile, so audience-fit
//   is measured against who the site says it serves, not a fresh guess.
//   The profile ships in the report so the benchmark itself is visible.
//
// CRAWL LANES (added 2026-07-21): content URLs (blog/resources posts —
// anything under a content path, or discovered from a content index page)
// get the bulk of the page budget; core pages (home, services, about) get a
// small fixed lane. Before this, homepage nav links filled the budget in
// discovery order and crowded actual blog posts out of the report.
//
// FLOW: index.html generates a job id -> POSTs {url, jobId} to
// /api/analyze-background (this file, returns 202 immediately, keeps running)
// -> this function renders pages, profiles the business, classifies with
// Claude, writes the result to Blobs under that job id -> index.html polls
// /api/analyze-status?id=... until status is "done" or "error".

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

// MEMORY BUDGET (learned live 2026-07-21): Netlify functions run in a fixed
// ~1GB container. Chromium alone eats most of that; parallel tabs got the
// function OOM-killed mid-crawl — an uncatchable death that writes no error
// blob, so the client saw "pending" forever. One tab at a time survives; the
// 15-minute background budget has plenty of room for sequential renders.
const CONTENT_MAX_PAGES = 14; // blog/resources posts — the content actually being audited
const CONTEXT_MAX_PAGES = 4;  // home + core pages — feed the business profile, still classified
const NAV_TIMEOUT_MS = 20000; // per-page render budget
const CONCURRENCY = 1; // ONE tab at a time — see memory-budget note above; do not raise without re-testing a multi-page site
const MAX_CHARS_PER_PAGE = 2200;
const MAX_CHARS_PROFILE_PAGE = 1800;

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
// A URL is CONTENT (an individual post/piece) when it has a slug UNDER one of
// the content-index segments — /blog/some-post is content, /blog itself is a
// core/index page, /services is core.
const CONTENT_PATH = /^\/(blog|resources|insights|articles|content|news|case-studies|guides|learn)\/.+/i;
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

function isContentUrl(url) {
  try {
    return CONTENT_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function launchBrowser() {
  await loadBrowserDeps();
  // Disable WebGL/graphics — we only read text and links, and skipping the
  // graphics stack saves meaningful memory in the 1GB container.
  chromium.setGraphicsMode = false;
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
    // Two lanes: content pieces (audited) vs core pages (profile + context).
    const contentUrls = new Set();
    const contextUrls = new Set();
    const addLink = (url, fromContentIndex) => {
      if (fromContentIndex || isContentUrl(url)) contentUrls.add(url);
      else contextUrls.add(url);
    };

    const seedRender = await renderPage(browser, seed);
    if (!seedRender.ok) throw new Error(`Could not render ${seed}: ${seedRender.error}`);
    filterLinks(seedRender.hrefs, seed, hostname).forEach((l) => addLink(l, false));

    const homeUrl = normalizeUrl(new URL(seed).origin, seed);
    let homeRender = null;
    if (homeUrl && homeUrl !== seed) {
      homeRender = await renderPage(browser, homeUrl);
      if (homeRender.ok) filterLinks(homeRender.hrefs, homeUrl, hostname).forEach((l) => addLink(l, false));
    }

    // Expand any index-like page (e.g. /blog) one level to pick up individual
    // posts — links discovered here go to the CONTENT lane regardless of path
    // shape, since they were found on a content index.
    const indexLike = [...contentUrls, ...contextUrls]
      .filter((l) => INDEX_HINT.test(new URL(l).pathname))
      .slice(0, 5);
    const expandResults = await mapWithConcurrency(indexLike, CONCURRENCY, (l) => renderPage(browser, l));
    expandResults.forEach((res, i) => {
      if (res.ok) filterLinks(res.hrefs, indexLike[i], hostname).forEach((l) => addLink(l, true));
    });

    // Seed + home always included; anything in the content lane can't also
    // occupy a context slot.
    (isContentUrl(seed) ? contentUrls : contextUrls).add(seed);
    if (homeUrl) contextUrls.add(homeUrl);
    contentUrls.forEach((u) => contextUrls.delete(u));

    // Content gets the big lane, core pages the small one — this is the fix
    // for service pages crowding blog posts out of the budget.
    const pageEntries = [];
    const seen = new Set();
    [...contentUrls].slice(0, CONTENT_MAX_PAGES).forEach((u) => {
      if (!seen.has(u)) { seen.add(u); pageEntries.push({ url: u, kind: 'content' }); }
    });
    [...contextUrls].slice(0, CONTEXT_MAX_PAGES).forEach((u) => {
      if (!seen.has(u)) { seen.add(u); pageEntries.push({ url: u, kind: 'core' }); }
    });

    // Reuse every render we've already done instead of re-rendering.
    const already = new Map();
    already.set(seed, seedRender);
    if (homeUrl && homeRender) already.set(homeUrl, homeRender);
    indexLike.forEach((u, i) => { if (!already.has(u)) already.set(u, expandResults[i]); });

    const renders = await mapWithConcurrency(pageEntries, CONCURRENCY, async (entry) => {
      if (already.has(entry.url)) return already.get(entry.url);
      return renderPage(browser, entry.url);
    });

    const pages = [];
    const skipped = [];
    renders.forEach((res, i) => {
      const entry = pageEntries[i];
      if (res.ok && res.text && res.text.length > 200) {
        pages.push({ url: entry.url, title: res.title || entry.url, text: res.text, kind: entry.kind });
      } else if (res.ok) {
        skipped.push({ url: entry.url, title: res.title || entry.url, reason: 'empty_after_render' });
      } else {
        skipped.push({ url: entry.url, title: entry.url, reason: 'render_failed', detail: res.error });
      }
    });

    return { pages, skipped, urls_found: pageEntries.length };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- Claude stage 1: business profile from core pages ----------

function buildProfilePrompt(profilePages) {
  const blocks = profilePages
    .map((p, i) => `PAGE ${i + 1}\nURL: ${p.url}\nTITLE: ${p.title}\nTEXT:\n${p.text.slice(0, MAX_CHARS_PROFILE_PAGE)}\n`)
    .join('\n---\n');

  return `You are reading a company's core website pages (home, services, about) to write down who this business is, held to this definition: a business exists to solve a problem for a qualified audience.

CORE PAGES (${profilePages.length}):
${blocks}

Return ONLY a JSON object, no markdown fences, no preamble, exactly this shape:
{
  "who": "1-2 sentences in the form: [Company] helps [the qualified audience] solve [the problem] by [how they solve it]. Plain, specific, no marketing gloss.",
  "problem": "The problem they solve, in one plain sentence.",
  "solution": "How they solve it, in one plain sentence.",
  "audience": "Who specifically they solve it for — the qualified audience, as narrow as the site supports.",
  "clarity_note": "1 sentence on how clearly the site itself states all this. If you had to infer heavily because the site never says it plainly, say so — that is itself a finding."
}
Keep every string under 300 characters. No markdown inside any string. If the pages genuinely don't support a confident answer, still fill every field with your best inference and let clarity_note say the site made you guess.`;
}

// ---------- Claude stage 2: classification against the profile ----------

function buildPrompt(pages, profile) {
  const jobLines = JOB_ORDER.map((k) => `- ${k} (${JOB_DEF[k].label}): ${JOB_DEF[k].job}`).join('\n');
  const pageBlocks = pages
    .map((p, i) => `PAGE ${i + 1}\nURL: ${p.url}\nTITLE: ${p.title}\nTEXT:\n${p.text}\n`)
    .join('\n---\n');

  return `You are auditing a company's owned content (site pages, blog posts) against a five-job "content capsule" framework used for MOFU (mid-funnel) B2B content strategy.

BUSINESS PROFILE — derived from this company's own core pages. Score ALL audience fit against THIS profile, not a fresh guess of your own:
- Who they are: ${profile.who}
- Problem they solve: ${profile.problem}
- How they solve it: ${profile.solution}
- Qualified audience: ${profile.audience}

THE FIVE JOBS:
${jobLines}

RULES:
- Classify each page into exactly ONE best-fit job, OR mark it "unmatched" if it doesn't do any of the five jobs well enough to count — e.g. content that is mostly industry/market news about OTHER companies with only a token mention of this company's product does not count toward any job, even if loosely on-topic.
- Do not force-fit a borderline page into a job just to inflate its count. A weak/loose fit still counts (mark fit "loose"), but a page that isn't meaningfully doing the job at all goes to unmatched with a one-sentence reason.
- Flag "split_focus": true on any piece that does its assigned job well for most of its length but then breaks discipline with an unearned product pitch in the close (e.g. an educational piece that suddenly says "this is the problem X was built to solve" or drops a demo-request CTA). Note this in the piece's one-line note.
- Flag near-duplicate pieces (two pieces that share the same structure/template and could not function as genuinely separate pieces toward the 3-piece minimum) by giving them matching "duplicate_group" values (e.g. "dup-1") — omit this field entirely for pieces with no duplicate.
- For each job, score 0-100 using these subweights: presence+count (0-40, scaled by how close the piece count is to a 3-piece minimum — pieces in the same duplicate_group only count as ONE toward this), audience fit (0-30, how well the piece speaks to the QUALIFIED AUDIENCE in the business profile above — a well-written piece aimed at the wrong reader scores low here), job completion (0-30, does the content actually accomplish what the job needs FOR that audience, quote-worthy specifics over vague gestures — dock split_focus pieces here).
- In each job's diagnosis, say how well the pieces inform and advance the profile's qualified audience specifically — not readers in general.
- A job with 0 pieces scores low (roughly 0-15) even if you're being generous elsewhere — do not round up out of politeness.
- composite_score is the plain average of the five job scores, rounded to the nearest whole number.

PAGES CRAWLED (${pages.length} total):
${pageBlocks}

Return ONLY a JSON object, no markdown fences, no preamble, exactly this shape:
{
  "composite_score": 41,
  "jobs": {
    "symptom": {"score": 65, "diagnosis": "1-3 sentences on what's working and what's missing for the profile's audience, plain prose", "pieces": [{"url": "...", "title": "...", "fit": "strong|loose", "note": "1 short sentence on this specific piece", "split_focus": false, "duplicate_group": null}]},
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

async function callClaude(prompt, maxTokens) {
  const { ANTHROPIC_API_KEY } = process.env;
  if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY.');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
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

async function profileBusiness(pages) {
  // Prefer core pages (home/services/about); fall back to whatever exists.
  const corePages = pages.filter((p) => p.kind === 'core');
  const profilePages = (corePages.length ? corePages : pages).slice(0, 4);
  const raw = await callClaude(buildProfilePrompt(profilePages), 700);
  return {
    who: sanitizeStr(raw.who, 320),
    problem: sanitizeStr(raw.problem, 320),
    solution: sanitizeStr(raw.solution, 320),
    audience: sanitizeStr(raw.audience, 320),
    clarity_note: sanitizeStr(raw.clarity_note, 320),
    derived_from: profilePages.map((p) => p.url),
  };
}

async function classify(pages, profile) {
  return callClaude(buildPrompt(pages, profile), 3200);
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

    // Stage 1: who is this business? (benchmark for everything below)
    const profile = await profileBusiness(pages);

    // Stage 2: classify + score every page against that profile.
    const parsed = await classify(pages, profile);
    if (!parsed.jobs || typeof parsed.jobs !== 'object') {
      await store.setJSON(jobId, { status: 'error', error: 'The analysis came back in an unexpected shape.' });
      return { statusCode: 200 };
    }

    const clean = {
      urls_found,
      pages_crawled: pages.length,
      pages_skipped: skipped.length,
      content_pages: pages.filter((p) => p.kind === 'content').length,
      core_pages: pages.filter((p) => p.kind === 'core').length,
      source_url: seedUrl,
      business_profile: profile,
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

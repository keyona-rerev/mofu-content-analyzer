// Netlify Function: POST /api/analyze
// T029 — MOFU Content Analyzer. Crawls a site, classifies every substantive
// page into one of five content-capsule JOBS (or Unmatched), scores each job
// 0-100 against the 2-3 subweights below, and checks the 3-piece minimum.
//
// No lead gate, no DB, no email — internal tool. Stateless: crawl -> classify
// -> return JSON. The front end (index.html) renders the report client-side
// in the same template as the manual Lanyard Health pilot run.
//
// Returns a full "page_inventory" alongside the per-job breakdown so the
// response is auditable: every single page the crawler found, in one list,
// with what job (if any) it was assigned and why — not just aggregated counts.
//
// KNOWN CONSTRAINT: Netlify's default function timeout (10s on most plans)
// caps how much a single invocation can crawl. MAX_PAGES and PER_PAGE_TIMEOUT_MS
// below are tuned to stay under that for a normal marketing-site blog. For a
// much larger site, this needs a background function (netlify/functions/*-background.js,
// 15 min budget) instead of a synchronous one — flagging as a v1 limitation,
// not solved here.
//
// ALSO KNOWN: sites that render content client-side (React/Vue SPAs with no
// prerendering) will crawl as empty shells here, since this does a plain
// fetch() and never executes JavaScript. Pages under ~200 chars of extracted
// text are dropped before they ever reach Claude — if pages_crawled comes
// back at 0 or suspiciously low for a real site, that's almost certainly why.

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

const MAX_PAGES = 18;
const PER_PAGE_TIMEOUT_MS = 6000;
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

// ---------- crawl helpers ----------

const BLOCK_PATH = /\/(login|signin|signup|terms|privacy|cookie-policy|cart|checkout)(\/|$|\?)/i;
const INDEX_HINT = /\/(blog|resources|insights|articles|content|news|case-studies|guides|learn)(\/|$|\?)/i;

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function extractLinks(html, baseUrl, hostname) {
  const links = new Set();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const abs = normalizeUrl(m[1], baseUrl);
    if (!abs) continue;
    try {
      const u = new URL(abs);
      if (u.hostname.replace(/^www\./, '') !== hostname.replace(/^www\./, '')) continue;
      if (BLOCK_PATH.test(u.pathname)) continue;
      links.add(abs);
    } catch { /* skip */ }
  }
  return links;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim().slice(0, 140) : '';
}

function extractText(html) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return t.slice(0, MAX_CHARS_PER_PAGE);
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    // Cache-busting query param: many hosts (Netlify, Framer, Vercel, Cloudflare, etc.)
    // cache pages at the edge keyed by exact URL, and a no-cache *request* header alone
    // does not force that edge cache to revalidate — only the origin's own response
    // headers control that. Appending a unique param guarantees a fresh edge hit every
    // time, which is what fixes the "site shows an old version after a real edit" bug.
    const bustUrl = url + (url.includes('?') ? '&' : '?') + '_cb=' + Date.now();
    const r = await fetch(bustUrl, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MOFUContentAnalyzer/1.0)',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

async function crawl(seedUrl) {
  const seed = normalizeUrl(seedUrl, seedUrl);
  const hostname = new URL(seed).hostname;

  const seedRes = await fetchWithTimeout(seed, PER_PAGE_TIMEOUT_MS);
  if (!seedRes.ok) throw new Error(`Could not fetch ${seed} (status ${seedRes.status}).`);

  const candidateLinks = extractLinks(seedRes.text, seed, hostname);
  const homeUrl = normalizeUrl(new URL(seed).origin, seed);
  if (homeUrl && homeUrl !== seed) {
    try {
      const homeRes = await fetchWithTimeout(homeUrl, PER_PAGE_TIMEOUT_MS);
      if (homeRes.ok) extractLinks(homeRes.text, homeUrl, hostname).forEach((l) => candidateLinks.add(l));
    } catch { /* homepage optional */ }
  }

  // Expand any index-like page (e.g. /blog) one level to pick up individual posts.
  const indexLike = [...candidateLinks].filter((l) => INDEX_HINT.test(new URL(l).pathname)).slice(0, 5);
  const expandResults = await Promise.allSettled(
    indexLike.map((l) => fetchWithTimeout(l, PER_PAGE_TIMEOUT_MS))
  );
  expandResults.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value.ok) {
      extractLinks(res.value.text, indexLike[i], hostname).forEach((l) => candidateLinks.add(l));
    }
  });

  candidateLinks.add(seed);
  if (homeUrl) candidateLinks.add(homeUrl);

  const pageUrls = [...candidateLinks].slice(0, MAX_PAGES);

  const fetched = await Promise.allSettled(
    pageUrls.map((u) => fetchWithTimeout(u, PER_PAGE_TIMEOUT_MS))
  );

  const pages = [];
  const skipped = [];
  fetched.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value.ok) {
      const html = res.value.text;
      const text = extractText(html);
      if (text.length > 200) {
        pages.push({ url: pageUrls[i], title: extractTitle(html) || pageUrls[i], text });
      } else {
        // Found the URL, but there was effectively no readable text after stripping
        // tags — almost always a client-rendered page with no prerendering.
        skipped.push({ url: pageUrls[i], title: extractTitle(html) || pageUrls[i], reason: 'empty_after_render' });
      }
    } else {
      skipped.push({ url: pageUrls[i], title: pageUrls[i], reason: 'fetch_failed' });
    }
  });

  return { pages, skipped, urls_found: pageUrls.length };
}

// ---------- Claude classification ----------

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Bad request.' }); }

  const rawUrl = String(body.url || '').trim();
  if (!rawUrl || rawUrl.length > 300) return json(400, { error: 'Please enter a valid URL.' });

  let seedUrl;
  try {
    seedUrl = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).href;
  } catch {
    return json(400, { error: 'That does not look like a valid URL.' });
  }

  const { ANTHROPIC_API_KEY } = process.env;
  if (!ANTHROPIC_API_KEY) return json(500, { error: 'The tool is not fully configured yet (missing ANTHROPIC_API_KEY).' });

  let crawlResult;
  try {
    crawlResult = await crawl(seedUrl);
  } catch (e) {
    return json(502, { error: `Could not crawl that site: ${String(e.message || e).slice(0, 200)}` });
  }
  const { pages, skipped, urls_found } = crawlResult;
  if (!pages.length) {
    return json(502, {
      error: 'Crawled the site but found no readable content pages.',
      urls_found,
      skipped: skipped.slice(0, 20).map((s) => ({ url: s.url, reason: s.reason })),
      hint: 'If urls_found is > 0 but every one is "empty_after_render", this site likely renders content client-side (React/Vue/etc.) with no prerendering — this crawler cannot execute JavaScript, so it sees an empty shell for every page.',
    });
  }

  let parsed;
  try {
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
      return json(502, { error: "The analysis didn't come through. Please try again.", stage: 'anthropic_api', detail: String(detail).slice(0, 200) });
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json(502, { error: "The analysis didn't come through. Please try again.", stage: 'no_json' });
    parsed = JSON.parse(m[0]);
  } catch (e) {
    return json(502, { error: "The analysis didn't come through. Please try again.", stage: 'fetch_failed', detail: String(e.message || e).slice(0, 200) });
  }

  if (!parsed.jobs || typeof parsed.jobs !== 'object') {
    return json(502, { error: "The analysis came back in an unexpected shape.", stage: 'shape_invalid' });
  }

  const clean = {
    urls_found,
    pages_crawled: pages.length,
    pages_skipped: skipped.length,
    source_url: seedUrl,
    jobs: {},
    unmatched: [],
    page_inventory: [], // every crawled page, one row each, in one place
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

  return json(200, clean);
};

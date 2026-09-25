#!/usr/bin/env node
// Site check. Node built-ins only, no install step. Prints every failure and exits 1 if
// there is one (2 if it cannot run). Every list and threshold lives in check-site.config.json;
// scripts/check-site.test.mjs proves each rule fails on a planted defect.
//
//   node scripts/check-site.mjs                        structural + freshness (default)
//   node scripts/check-site.mjs --freshness=warn       expiry is printed, not fatal (deploys)
//   node scripts/check-site.mjs --freshness=changed --base origin/main
//                                                      expiry is fatal only where this change
//                                                      adds or edits claim-bearing content
//
// Structural rules are always fatal: what the pages promise each other (one header, one
// footer, working links, honest dates, no external requests) and what the site promises
// readers (no banned absolutes, nothing private, every product claim backed by a record,
// tutorial prose free of the mechanical signs of AI writing).
// CHECK_TODAY=YYYY-MM-DD overrides today's date (tests).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/check-site.mjs';
const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts/check-site.config.json'), 'utf8'));
const SITE = join(ROOT, cfg.site_dir);
const TODAY = process.env.CHECK_TODAY || new Date().toISOString().slice(0, 10);

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : process.argv[process.argv.indexOf(hit) + 1];
};
const FRESHNESS = arg('freshness', 'error');
if (!['error', 'warn', 'changed'].includes(FRESHNESS)) { console.error(`unknown --freshness=${FRESHNESS}`); process.exit(2); }

const failures = [];
const warnings = [];
const fail = (where, msg) => failures.push(`${where}: ${msg}`);

// ---------------------------------------------------------------- discovery
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const rel = (from, full) => relative(from, full).split('\\').join('/');
const repoFiles = walk(ROOT).map((f) => rel(ROOT, f)).sort();
const urlFor = (r) => (r === 'index.html' ? '/' : r.endsWith('/index.html') ? '/' + r.slice(0, -'index.html'.length) : '/' + r);
const pages = walk(SITE).filter((f) => f.endsWith('.html')).map((full) => {
  const r = rel(SITE, full);
  return { where: `${cfg.site_dir}/${r}`, rel: r, url: urlFor(r), html: readFileSync(full, 'utf8'), noindex: cfg.noindex.includes(urlFor(r)) };
});
const template = existsSync(join(ROOT, cfg.template))
  ? { where: cfg.template, rel: null, url: null, html: readFileSync(join(ROOT, cfg.template), 'utf8'), noindex: true, template: true }
  : null;
if (!template) fail(cfg.template, 'missing tutorial template');
const all = template ? [...pages, template] : pages;
const byRel = new Map(pages.map((p) => [p.rel, p]));
const isArticle = (p) => p.template || /^\/learn\/[^/]+\/$/.test(p.url || '');
const slugOf = (p) => (p.rel ? (p.rel.match(/^learn\/([^/]+)\/index\.html$/) || [])[1] : null);

// ---------------------------------------------------------------- HTML helpers (quote-aware)
const TAG = /<([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
function attrsOf(attrText) {
  const out = {};
  for (const m of attrText.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}
const tagsIn = (html) => [...html.matchAll(TAG)].map((m) => ({ name: m[1].toLowerCase(), attrs: attrsOf(m[2]), raw: m[0], index: m.index }));
const classes = (t) => (t.attrs.class || '').split(/\s+/).filter(Boolean);
const between = (html, open, close) => {
  const i = html.indexOf(open), j = html.indexOf(close, i + 1);
  return i < 0 || j < 0 ? null : html.slice(i + open.length, j);
};
const meta = (html, name) => tagsIn(html).find((t) => t.name === 'meta' && t.attrs.name === name)?.attrs.content ?? null;
const stripBlocks = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
const textOf = (html) => html.replace(/<\/(p|li|h[1-6]|td|th|dd|dt|figcaption|blockquote)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
const ids = (html) => tagsIn(html).map((t) => t.attrs.id).filter(Boolean);
const isoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
function existsExact(root, path) { // case-sensitive, like Cloudflare, even on macOS
  let dir = root;
  for (const seg of path.split('/').filter(Boolean)) {
    if (!existsSync(dir) || !statSync(dir).isDirectory() || !readdirSync(dir).includes(seg)) return false;
    dir = join(dir, seg);
  }
  return existsSync(dir);
}

// ---------------------------------------------------------------- freshness modes
// "changed": expiry is fatal only for files this change adds claim-bearing content to —
// any added line in a page that carries evidence badges or claim references, or in a
// claims file. A removal-only change passes, so deleting a stale claim is never blocked.
let touched = null;
if (FRESHNESS === 'changed') {
  const base = arg('base', 'origin/main');
  const diff = (args) => execFileSync('git', ['-C', ROOT, 'diff', '-U0', '--no-color', ...args], { encoding: 'utf8' });
  try {
    touched = new Set();
    let file = null;
    for (const line of [diff([`${base}...HEAD`]), diff(['--cached']), diff([])].join('\n').split('\n')) {
      if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
      else if (line.startsWith('+') && file) touched.add(file);
    }
    for (const f of [...touched]) {
      const text = existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8') : '';
      if (!(f.startsWith('claims/') || /class="[^"]*\bev\b|data-claim=/.test(text))) touched.delete(f);
    }
  } catch (e) { console.error(`cannot diff against ${base}: ${e.message}`); process.exit(2); }
}
function freshness(files, where, msg) {
  const fatal = FRESHNESS === 'error' || (FRESHNESS === 'changed' && files.some((f) => touched.has(f)));
  (fatal ? failures : warnings).push(`${where}: ${msg}`);
}

// ---------------------------------------------------------------- 1. shared header and footer
const expectedNav = (url) => {
  if (url === null) return ['/learn/', 'true']; // the template becomes a tutorial
  if (cfg.no_current_nav.includes(url)) return null;
  if (url === '/') return ['/', 'page'];
  const n = cfg.nav.find((x) => x !== '/' && url.startsWith(x));
  return n ? [n, url === n ? 'page' : 'true'] : null;
};
const strip = (block) => block && block.replace(/ aria-current="(page|true)"/g, '');
let ref = null;
for (const p of all) {
  const header = between(p.html, '<!-- site-header -->', '<!-- /site-header -->');
  const footer = between(p.html, '<!-- site-footer -->', '<!-- /site-footer -->');
  if (!header || !footer) { fail(p.where, 'missing <!-- site-header --> or <!-- site-footer --> block'); continue; }
  if (!ref) ref = { header: strip(header), footer: strip(footer), from: p.where };
  else {
    if (strip(header) !== ref.header) fail(p.where, `header differs from ${ref.from} — copy the block exactly`);
    if (strip(footer) !== ref.footer) fail(p.where, `footer differs from ${ref.from} — copy the block exactly`);
  }
  const current = tagsIn(header).filter((t) => t.name === 'a' && t.attrs['aria-current']).map((t) => [t.attrs.href, t.attrs['aria-current']]);
  const want = expectedNav(p.url);
  const got = current.map((c) => c.join(' ')).join(', ');
  if (want === null && current.length) fail(p.where, `no nav link may be marked current here; found ${got}`);
  if (want !== null && (current.length !== 1 || current[0][0] !== want[0] || current[0][1] !== want[1])) {
    fail(p.where, `nav must mark exactly ${want[0]} aria-current="${want[1]}"; found [${got}]`);
  }
  if (!p.html.includes('<a class="skip" href="#main">')) fail(p.where, 'missing skip link to #main');
  if (!/<main id="main"/.test(p.html)) fail(p.where, 'missing <main id="main">');
}

// ---------------------------------------------------------------- 2. head, sitemap, robots, headers
const titles = new Map();
const indexable = [];
for (const p of all) {
  const h = p.html, tags = tagsIn(h);
  if (!/^<!doctype html>/i.test(h.trimStart())) fail(p.where, 'must start with <!doctype html>');
  if (!h.includes('<html lang="en">')) fail(p.where, 'missing <html lang="en">');
  if (!/<meta charset="utf-8">/i.test(h)) fail(p.where, 'missing <meta charset="utf-8">');
  if (!h.includes('<meta name="viewport" content="width=device-width, initial-scale=1">')) fail(p.where, 'missing viewport meta');
  const title = (h.match(/<title>([^<]*)<\/title>/) || [])[1]?.trim();
  if (!title) fail(p.where, 'missing <title>');
  else if (titles.has(title)) fail(p.where, `title duplicates ${titles.get(title)}`);
  else titles.set(title, p.where);
  const links = tags.filter((t) => t.name === 'link');
  const sheets = links.filter((l) => l.attrs.rel === 'stylesheet').map((l) => l.attrs.href);
  if (sheets.length !== 1 || sheets[0] !== cfg.stylesheet) fail(p.where, `must link exactly one stylesheet: ${cfg.stylesheet}`);
  if (!links.some((l) => l.attrs.rel === 'icon' && l.attrs.href === cfg.favicon)) fail(p.where, `must link the favicon ${cfg.favicon}`);
  const canon = links.find((l) => l.attrs.rel === 'canonical');
  const robots = meta(h, 'robots');
  if (p.noindex) {
    if (robots !== 'noindex' && !p.template) fail(p.where, 'noindex page must carry <meta name="robots" content="noindex">');
    if (canon) fail(p.where, 'noindex page must not declare a canonical URL');
  } else {
    indexable.push(p.url);
    if (robots) fail(p.where, 'indexable page must not carry a robots meta');
    if (!canon || canon.attrs.href !== cfg.origin + p.url) fail(p.where, `canonical must be ${cfg.origin + p.url}`);
    const desc = meta(h, 'description');
    const [lo, hi] = cfg.description_length;
    if (!desc || desc.length < lo || desc.length > hi) fail(p.where, `meta description must be ${lo}–${hi} characters (is ${desc ? desc.length : 0})`);
  }
}
const readSite = (name) => (existsSync(join(SITE, name)) ? readFileSync(join(SITE, name), 'utf8') : '');
const sitemap = readSite('sitemap.xml');
if (!sitemap) fail('site/sitemap.xml', 'missing');
const sitemapEntries = [...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?\s*<\/url>/g)].map((m) => ({ loc: m[1], lastmod: m[2] || null }));
const locs = sitemapEntries.map((e) => e.loc).sort();
const wantLocs = indexable.map((u) => cfg.origin + u).sort();
if (JSON.stringify(locs) !== JSON.stringify(wantLocs)) fail('site/sitemap.xml', `must list exactly the indexable pages\n      want: ${wantLocs.join(' ')}\n      have: ${locs.join(' ')}`);
if (!readSite('robots.txt').includes(`Sitemap: ${cfg.origin}/sitemap.xml`)) fail('site/robots.txt', 'must name the sitemap');

// _headers: parse rules; the catch-all rule must carry every required header with its exact value.
const headerRules = [];
for (const line of readSite('_headers').split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (!/^\s/.test(line)) headerRules.push({ path: line.trim(), headers: [] });
  else if (headerRules.length) { const i = line.indexOf(':'); headerRules.at(-1).headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
}
const catchAll = headerRules.find((r) => r.path === cfg.headers_rule);
if (!catchAll) fail('site/_headers', `missing the ${cfg.headers_rule} rule`);
for (const [name, value] of Object.entries(cfg.required_headers)) {
  const got = catchAll?.headers.filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v) || [];
  if (got.length !== 1 || got[0] !== value) fail('site/_headers', `${cfg.headers_rule} must send exactly "${name}: ${value}"`);
  for (const r of headerRules) if (r !== catchAll && r.headers.some(([n]) => n.toLowerCase() === name.toLowerCase())) fail('site/_headers', `${name} redefined on ${r.path} — Cloudflare would join the two values`);
}

// ---------------------------------------------------------------- 3. links, resources, scripts
for (const p of all) {
  const tags = tagsIn(p.html);
  for (const t of tags) {
    if (Object.keys(t.attrs).some((a) => /^on[a-z]+$/.test(a))) fail(p.where, `inline event handler on <${t.name}> — navigation must work without JavaScript`);
    if (t.name === 'script' && !t.attrs.src && t.attrs.type !== 'application/ld+json') fail(p.where, 'executable inline <script> — move it to /assets/*.js (CSP forbids it)');
    if (t.name === 'script' && t.attrs.src && !t.attrs.src.startsWith('/assets/')) fail(p.where, `script must be same-origin under /assets/: ${t.attrs.src}`);
    const refs = [t.attrs.href, t.attrs.src, t.attrs.data, t.attrs.poster, ...(t.attrs.srcset || '').split(',').map((s) => s.trim().split(/\s+/)[0])].filter((v) => v);
    for (const refv of refs) {
      if (/^(https?:)?\/\//i.test(refv)) {
        const outboundOk = (t.name === 'a' && refv === t.attrs.href) || (t.name === 'link' && t.attrs.rel === 'canonical');
        if (!outboundOk) fail(p.where, `external resource <${t.name}> ${refv} — the site makes no external requests`);
        if (/^http:/i.test(refv)) fail(p.where, `insecure link ${refv}`);
        continue;
      }
      if (/^(mailto|tel|javascript|data):/i.test(refv)) { fail(p.where, `disallowed URL scheme: ${refv}`); continue; }
      const [path, frag] = refv.split('#');
      let target = p;
      if (path) {
        if (!path.startsWith('/')) { fail(p.where, `use a root-relative link: ${refv}`); continue; }
        if (/(^|\/)\.\.?(\/|$)|\/\//.test(path)) { fail(p.where, `link path must not contain . or .. segments: ${refv}`); continue; }
        if (/(^|\/)index\.html$/.test(path) || (/\.html$/.test(path) && path !== '/404.html')) { fail(p.where, `link to the clean URL, not ${refv} (Cloudflare redirects .html)`); continue; }
        if (!/\.[a-z0-9]+$/i.test(path) && !path.endsWith('/')) { fail(p.where, `directory links end in "/": ${refv}`); continue; }
        const r = decodeURIComponent(path.slice(1)) + (path.endsWith('/') ? 'index.html' : '');
        if (!existsExact(SITE, r)) { fail(p.where, `broken link ${refv} (paths are case-sensitive)`); continue; }
        if (cfg.unlinked_pages.includes(path) && p.url !== path) fail(p.where, `${path} must stay unlinked from other pages`);
        target = byRel.get(r);
      }
      if (frag) {
        if (!target) { fail(p.where, `fragment on a non-page target: ${refv}`); continue; }
        if (!ids(target.html).includes(frag)) fail(p.where, `broken fragment ${refv}`);
      }
    }
  }
}
for (const f of repoFiles.filter((x) => x.startsWith(`${cfg.site_dir}/`) && x.endsWith('.css'))) {
  if (/@import|url\(\s*["']?(https?:)?\/\//i.test(readFileSync(join(ROOT, f), 'utf8'))) fail(f, 'CSS must not import or load external resources');
}

// ---------------------------------------------------------------- 4. structure and accessibility
for (const p of all) {
  const tags = tagsIn(p.html);
  const h1s = tags.filter((t) => t.name === 'h1').length;
  if (h1s !== 1) fail(p.where, `must have exactly one <h1>, found ${h1s}`);
  let prev = 1;
  for (const t of tags) {
    const m = t.name.match(/^h([1-6])$/);
    if (!m) continue;
    if (Number(m[1]) > prev + 1) fail(p.where, `heading level jumps from h${prev} to h${m[1]}`);
    prev = Number(m[1]);
  }
  const seen = new Set();
  for (const id of ids(p.html)) { if (seen.has(id)) fail(p.where, `duplicate id="${id}"`); seen.add(id); }
  const pageIds = new Set(ids(p.html));
  for (const pre of tags.filter((t) => t.name === 'pre')) {
    if (pre.attrs.tabindex !== '0') fail(p.where, '<pre> must have tabindex="0" so keyboard users can scroll it');
    if (!pre.attrs['aria-labelledby'] || !pageIds.has(pre.attrs['aria-labelledby'])) fail(p.where, '<pre> must be named by its figcaption (aria-labelledby)');
  }
}

// ---------------------------------------------------------------- 5. tutorials, claims, hub cards
function badgesIn(html) {
  return tagsIn(html).filter((t) => t.name === 'span' && classes(t).includes('ev')).map((t) => {
    const kinds = classes(t).filter((c) => c.startsWith('ev-'));
    return { kinds, kind: kinds[0], claim: t.attrs['data-claim'] || null, raw: t.raw };
  });
}
function loadClaims(fileRel) {
  if (!existsSync(join(ROOT, fileRel))) return null;
  try { return new Map((JSON.parse(readFileSync(join(ROOT, fileRel), 'utf8')).claims || []).map((c) => [c.id, c])); }
  catch { fail(fileRel, 'not valid JSON'); return new Map(); }
}
function checkRecord(fileRel, id, c, usedBy) {
  const where = `${fileRel} ${id}`;
  for (const k of ['wording', 'evidence_class', 'strength', 'versions', 'verified_on', 'review_by', 'owner']) if (!c[k]) fail(where, `missing ${k}`);
  if (!c.evidence_link && !c.evidence_private_reason) fail(where, 'needs evidence_link or evidence_private_reason');
  if (c.evidence_class && !(c.evidence_class in cfg.claim_evidence_badges)) fail(where, `evidence_class must be one of: ${Object.keys(cfg.claim_evidence_badges).join(', ')}`);
  if (c.strength && !cfg.claim_strengths.includes(c.strength)) fail(where, `strength must be one of ${cfg.claim_strengths.join(', ')}`);
  if (c.owner && !/maintainers|team/i.test(c.owner)) fail(where, 'owner must name a role, not a person');
  if (c.verified_on && (!isoDate(c.verified_on) || c.verified_on > TODAY)) fail(where, 'verified_on must be a date, not in the future');
  if (c.review_by && !isoDate(c.review_by)) fail(where, 'review_by must be YYYY-MM-DD');
  if (isoDate(c.verified_on) && isoDate(c.review_by) && days(c.verified_on, c.review_by) > cfg.review_by_max_days) fail(where, `review_by may be at most ${cfg.review_by_max_days} days after verified_on`);
  if (isoDate(c.review_by) && c.review_by < TODAY) freshness([fileRel, ...usedBy], where, `review_by ${c.review_by} has passed`);
}
function checkClaimRefs(p, fileRel, recs, refs) {
  for (const b of refs) {
    if (!recs.has(b.claim)) { fail(p.where, `data-claim="${b.claim}" has no record in ${fileRel}`); continue; }
    const allowed = cfg.claim_evidence_badges[recs.get(b.claim).evidence_class] || [];
    if (b.kind && !allowed.includes(b.kind)) fail(p.where, `badge ${b.kind} for "${b.claim}" is stronger than its record (${recs.get(b.claim).evidence_class})`);
  }
}

const articleDates = new Map();
for (const p of all.filter(isArticle)) {
  const h = p.html;
  for (const [what, re] of [
    ['breadcrumb', /<p class="crumb"><a href="\/">Home<\/a> › <a href="\/learn\/">Learn<\/a> › /],
    ['eyebrow', /<p class="eyebrow">/], ['lede', /<p class="lede">/], ['verified-on panel', /<aside class="verified"/],
    ['table of contents', /<nav class="toc" aria-label="On this page">/], ['<article class="article">', /<article class="article">/],
    ['series navigation', /<nav class="series" aria-label="Series">/], ['last-verified line', /<p class="lastverified">/],
  ]) if (!re.test(h)) fail(p.where, `tutorial is missing its ${what}`);
  const toc = between(h, '<nav class="toc" aria-label="On this page">', '</nav>') || '';
  const tocIds = tagsIn(toc).filter((t) => t.name === 'a').map((t) => (t.attrs.href || '').replace(/^#/, ''));
  const body = between(h, '<article class="article">', '</article>') || '';
  const h2s = tagsIn(body).filter((t) => t.name === 'h2');
  if (h2s.some((t) => !t.attrs.id)) fail(p.where, 'every <h2> in the article needs an id');
  const h2Ids = h2s.map((t) => t.attrs.id).filter(Boolean);
  if (JSON.stringify(tocIds) !== JSON.stringify(h2Ids)) fail(p.where, `contents [${tocIds.join(', ')}] must equal the h2 ids in order [${h2Ids.join(', ')}]`);

  const legend = between(h, '<p class="legend">', '</p>') || '';
  const badges = badgesIn(h.replace(legend, ''));
  for (const b of badgesIn(h)) { // every badge, the legend included, must be a known kind
    if (b.kinds.length !== 1 || !cfg.evidence_classes.includes(b.kind)) fail(p.where, `evidence badge needs exactly one known kind: ${b.raw}`);
  }
  if (badges.some((b) => b.kind === 'ev-unverified') && !ids(h).includes('not-verified')) fail(p.where, '"Not verified" badges need a section with id="not-verified"');

  const slug = slugOf(p);
  const fileRel = slug ? `claims/${slug}.json` : null;
  const recs = fileRel ? loadClaims(fileRel) : null;
  const refs = tagsIn(h).filter((t) => t.attrs['data-claim']).map((t) => ({ claim: t.attrs['data-claim'], kind: classes(t).find((c) => c.startsWith('ev-')) }));
  if (recs) {
    for (const b of badges) if (cfg.claim_badge_classes.includes(b.kind) && !b.claim) fail(p.where, `${b.kind} badge without data-claim on a page that has claim records: ${b.raw}`);
    checkClaimRefs(p, fileRel, recs, refs);
    const used = new Set(refs.map((r) => r.claim));
    for (const [id, c] of recs) {
      if (!used.has(id)) fail(`${fileRel} ${id}`, 'claim record is not referenced by any badge');
      checkRecord(fileRel, id, c, [p.where]);
    }
  } else if (refs.length) fail(p.where, `data-claim references need ${fileRel || 'a claims file'}`);

  if (p.template) continue; // placeholder dates
  const verified = meta(h, 'verified-on'), review = meta(h, 'review-by');
  if (!isoDate(verified)) fail(p.where, 'meta verified-on must be YYYY-MM-DD');
  if (!isoDate(review)) fail(p.where, 'meta review-by must be YYYY-MM-DD');
  if (!meta(h, 'tested-versions')) fail(p.where, 'meta tested-versions is required');
  if (isoDate(verified) && verified > TODAY) fail(p.where, 'verified-on is in the future');
  if (isoDate(verified) && isoDate(review) && days(verified, review) > cfg.review_by_max_days) fail(p.where, `review-by may be at most ${cfg.review_by_max_days} days after verified-on`);
  if (isoDate(review) && review < TODAY) freshness([p.where, ...(fileRel ? [fileRel] : [])], p.where, `review-by ${review} has passed — re-verify the page and move both dates`);
  const ld = (h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
  try {
    const data = JSON.parse(ld);
    if (data['@type'] !== 'TechArticle') fail(p.where, 'JSON-LD @type must be TechArticle');
    if (data.dateModified !== verified) fail(p.where, 'JSON-LD dateModified must equal verified-on');
    if (data.mainEntityOfPage !== cfg.origin + p.url) fail(p.where, 'JSON-LD mainEntityOfPage must equal the canonical URL');
  } catch { fail(p.where, 'missing or invalid JSON-LD TechArticle'); }
  if (!h.includes(`Last verified ${verified} · review by ${review}`)) fail(p.where, `last-verified line must read "Last verified ${verified} · review by ${review}"`);
  const sm = sitemapEntries.find((e) => e.loc === cfg.origin + p.url);
  if (sm && sm.lastmod !== verified) fail('site/sitemap.xml', `lastmod for ${p.url} must equal its verified-on ${verified}`);
  articleDates.set(p.url, verified);
}

// Product claims on marketing pages are backed by claims/marketing.json.
const marketing = loadClaims('claims/marketing.json');
const marketingRefs = pages.filter((p) => !isArticle(p)).flatMap((p) => tagsIn(p.html).filter((t) => t.attrs['data-claim'])
  .map((t) => ({ p, claim: t.attrs['data-claim'], kind: classes(t).find((c) => c.startsWith('ev-')) })));
if (marketingRefs.length && !marketing) fail('claims/marketing.json', 'missing, but marketing pages reference claims');
if (marketing) {
  for (const p of new Set(marketingRefs.map((r) => r.p))) checkClaimRefs(p, 'claims/marketing.json', marketing, marketingRefs.filter((r) => r.p === p));
  for (const [id, c] of marketing) {
    const usedBy = [...new Set(marketingRefs.filter((r) => r.claim === id).map((r) => r.p.where))];
    if (!usedBy.length) fail(`claims/marketing.json ${id}`, 'claim record is not referenced by any page');
    checkRecord('claims/marketing.json', id, c, usedBy);
  }
}

const hub = byRel.get('learn/index.html');
if (hub) {
  const cards = [...hub.html.matchAll(/<li class="card">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  for (const card of cards) {
    const link = tagsIn(card).find((t) => t.name === 'a');
    const date = (card.match(/<p class="meta">[^<]*verified (\d{4}-\d{2}-\d{2})<\/p>/) || [])[1];
    if (!link || !date) { fail(hub.where, 'every tutorial card needs a link and a "verified YYYY-MM-DD" meta line'); continue; }
    if (articleDates.get(link.attrs.href) !== date) fail(hub.where, `card for ${link.attrs.href} says verified ${date} but the page says ${articleDates.get(link.attrs.href)}`);
  }
  for (const url of articleDates.keys()) if (!cards.some((c) => c.includes(`href="${url}"`))) fail(hub.where, `hub does not list ${url}`);
}

// ---------------------------------------------------------------- 6. banned absolutes
// Visible text plus the text search engines and assistive technology show: meta
// description, title/alt/aria-label attributes. Only the style guide may quote a banned
// term, inside <q class="term">, in order to discuss it.
const banned = cfg.banned_absolutes.map((s) => new RegExp(s, 'i'));
for (const p of all) {
  let html = stripBlocks(p.html);
  if (p.url === '/styleguide/') html = html.replace(/<q class="term">[\s\S]*?<\/q>/g, ' ');
  const attrText = tagsIn(html).flatMap((t) => [t.attrs['aria-label'], t.attrs.title, t.attrs.alt, t.name === 'meta' && t.attrs.name === 'description' ? t.attrs.content : null]).filter(Boolean).join(' ');
  const text = textOf(html) + ' ' + attrText;
  for (const re of banned) if (re.test(text)) fail(p.where, `banned absolute /${re.source}/ — weaken the claim`);
}

// ---------------------------------------------------------------- 7. voice (mechanical signs of AI writing)
// In the voice scope (tutorials, style guide, template, authoring guide): body prose only —
// the shared header/footer, code, and quoted terms are excluded. Judgement tells (triads,
// closers, inflation) are a review item, not a regex. See TUTORIALS.md "Voice".
const voiceRules = cfg.voice_rules.map((r) => ({ re: new RegExp(r.pattern, r.flags || 'g'), why: r.why }));
const inVoiceScope = (where) => cfg.voice_scope.some((s) => where.startsWith(s));
const proseOf = (html) => {
  let body = html.slice(html.indexOf('<main'));
  for (const [open, close] of [['<!-- site-footer -->', '<!-- /site-footer -->']]) { const i = body.indexOf(open); if (i >= 0) body = body.slice(0, i); }
  return stripBlocks(body).replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<code[\s\S]*?<\/code>/g, ' ').replace(/<q class="term">[\s\S]*?<\/q>/g, ' ');
};
function voiceCheck(where, prose, markup) {
  for (const r of voiceRules) {
    r.re.lastIndex = 0;
    const m = r.re.exec(prose);
    if (m) fail(where, `voice: ${r.why} — "${prose.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ').trim()}"`);
  }
  if (markup && /<li>\s*<(b|strong)>[^<]{1,60}(?:[:.]\s*<\/\1>|<\/\1>\s*[:.])/.test(markup)) fail(where, 'voice: list item opens with a bold label (colon or period form); write the point as a sentence');
}
for (const p of all.filter((x) => inVoiceScope(x.where))) {
  const prose = proseOf(p.html);
  voiceCheck(p.where, textOf(prose), prose);
}
for (const f of cfg.voice_docs) {
  if (!existsSync(join(ROOT, f))) continue;
  const md = readFileSync(join(ROOT, f), 'utf8').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/"[^"\n]*"/g, ' ');
  voiceCheck(f, md, null);
}

// ---------------------------------------------------------------- 8. public safety (every non-binary file)
const safety = cfg.public_safety.map((r) => ({ re: new RegExp(r.pattern, r.flags || ''), why: r.why, allow: r.allow_line ? new RegExp(r.allow_line) : null }));
for (const f of repoFiles) {
  if (cfg.forbidden_files.includes(f.split('/').pop())) { fail(f, 'remove this file (it would be published)'); continue; }
  if (f === SELF || cfg.public_safety_skip.includes(f)) continue;
  const buf = readFileSync(join(ROOT, f));
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  buf.toString('utf8').split('\n').forEach((line, i) => {
    for (const r of safety) if (r.re.test(line) && !(r.allow && r.allow.test(line))) fail(`${f}:${i + 1}`, `${r.why}: ${line.trim().slice(0, 100)}`);
  });
}

// ---------------------------------------------------------------- 9. contrast (text 4.5:1, focus indicators 3:1)
const css = readFileSync(join(SITE, cfg.stylesheet.slice(1)), 'utf8');
const tokens = {};
for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g)) for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2]; // later blocks win, as in CSS
const resolve = (c) => (c.startsWith('--') ? tokens[c] : c);
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
for (const [fg, bg, min] of cfg.contrast_pairs) {
  const f = resolve(fg), b = resolve(bg);
  if (!f || !b) { fail('site/assets/site.css', `contrast pair ${fg} on ${bg}: unknown token`); continue; }
  const [hi, lo] = [lum(f), lum(b)].sort((x, y) => y - x);
  const ratio = (hi + 0.05) / (lo + 0.05);
  if (ratio < min) fail('site/assets/site.css', `${fg} on ${bg} is ${ratio.toFixed(2)}:1, below ${min}:1`);
}

// ---------------------------------------------------------------- report
for (const w of warnings) console.warn(`  warning ${w}`);
if (failures.length) {
  console.error(`check-site: FAIL — ${failures.length} problem(s)\n`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`check-site: PASS — ${pages.length} pages (${indexable.length} indexed) + template, ${repoFiles.length} files, freshness=${FRESHNESS}, today ${TODAY}`);

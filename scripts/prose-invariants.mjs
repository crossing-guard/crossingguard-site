#!/usr/bin/env node
// Compare two versions of the site after a prose edit and report anything that is more
// than wording: evidence badges and claim ids, code (byte for byte), link targets, heading
// ids, and every number, version and date. A copy edit should change none of these; each
// reported difference must be deliberate and explained where the edit is reviewed.
//
//   node scripts/prose-invariants.mjs <before-repo-dir> <after-repo-dir> [page ...]
//
// Pages default to every HTML file present in both trees under site/. Exit 1 if any
// invariant differs.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const [before, after, ...only] = process.argv.slice(2);
if (!before || !after) { console.error('usage: prose-invariants.mjs <before> <after> [page ...]'); process.exit(2); }

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) { const f = join(dir, n); statSync(f).isDirectory() ? walk(f, out) : out.push(f); }
  return out;
};
const pagesIn = (root) => walk(join(root, 'site')).filter((f) => f.endsWith('.html')).map((f) => relative(root, f));
const pages = only.length ? only : pagesIn(before).filter((p) => existsSync(join(after, p)));

const main = (html) => {
  const i = html.indexOf('<main'), j = html.indexOf('<!-- site-footer -->');
  return html.slice(i < 0 ? 0 : i, j < 0 ? html.length : j);
};
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1] ?? m[0]);
const multiset = (xs) => xs.slice().sort();
const tokensOf = (html) => {
  const text = main(html).replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<code[\s\S]*?<\/code>/g, ' ').replace(/<[^>]+>/g, ' ');
  return multiset(all(/\b\d[\d.,:x-]*\d\b|\b\d\b/g, text)); // numbers, versions, dates, ranges
};
const facets = (html) => ({
  badges: multiset(all(/<span class="(ev [^"]+)"/g, html)),
  claims: multiset(all(/data-claim="([^"]+)"/g, html)),
  code: all(/<pre[^>]*>([\s\S]*?)<\/pre>/g, main(html)).map((c) => 'pre: ' + c).concat(all(/(<code>[\s\S]*?<\/code>)/g, main(html).replace(/<pre[\s\S]*?<\/pre>/g, ''))), // code content, byte for byte; pre attributes are markup
  hrefs: multiset(all(/href="([^"]+)"/g, main(html))),
  headings: all(/<h[1-6] id="([^"]+)"/g, html),
  tokens: tokensOf(html),
});

const diff = (a, b) => {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const ca = count(a), cb = count(b), out = [];
  for (const [k, n] of ca) if ((cb.get(k) || 0) < n) out.push(`- ${k}`);
  for (const [k, n] of cb) if ((ca.get(k) || 0) < n) out.push(`+ ${k}`);
  return out;
};

let changed = 0;
for (const p of pages) {
  const fa = facets(readFileSync(join(before, p), 'utf8')), fb = facets(readFileSync(join(after, p), 'utf8'));
  for (const k of Object.keys(fa)) {
    const d = k === 'headings' ? (JSON.stringify(fa[k]) === JSON.stringify(fb[k]) ? [] : [`- ${fa[k].join(' ')}`, `+ ${fb[k].join(' ')}`]) : diff(fa[k], fb[k]);
    if (d.length) { changed++; console.log(`${p}  ${k}:\n    ${d.map((x) => x.slice(0, 160)).join('\n    ')}`); }
  }
}
console.log(changed ? `\nprose-invariants: ${changed} facet(s) changed in ${pages.length} page(s)` : `prose-invariants: unchanged in ${pages.length} page(s)`);
process.exit(changed ? 1 : 0);

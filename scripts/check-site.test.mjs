#!/usr/bin/env node
// Self-test for check-site.mjs: every rule must fail on a planted defect, so a rule that
// silently stops working turns this red. Each case copies the repository to a temporary
// directory, plants one defect, runs the check and expects exit 1 with a known message.
//
//   node scripts/check-site.test.mjs
//
// Cases that need claim records plant a small fixture (a claims file plus a badge on
// Tutorial 1), so they run whether or not the repository has product-claim pages yet.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T1 = 'site/learn/claude-code-hooks/index.html';

const edit = (file, from, to) => (dir) => {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  const next = from instanceof RegExp ? text.replace(from, to) : text.replace(from, to);
  if (next === text) throw new Error(`fixture anchor not found in ${file}: ${from}`);
  writeFileSync(path, next);
};
const append = (file, text) => (dir) => writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8') + text);
const put = (file, text) => (dir) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };
const inMain = (file, html) => edit(file, '</main>', `${html}</main>`);
const inArticle = (html) => edit(T1, '</article>', `${html}</article>`);
const record = (over = {}) => ({ id: 'fx-1', wording: 'Fixture claim.', evidence_class: 'source-verified behavior', strength: 'observed',
  versions: 'fixture 1.0', verified_on: '2026-09-25', review_by: '2026-10-25', owner: 'Crossing Guard maintainers',
  evidence_private_reason: 'Fixture.', ...over });
// A valid claim fixture on Tutorial 1: one badge and its record.
// Tutorial 1's own Observed badges are vendor observations with no record; in the copy they
// become Vendor docs so that each case isolates the one rule it plants a defect for.
const claimFixture = (recs = [record()], badge = '<span class="ev ev-source" data-claim="fx-1">In source (not yet public)</span>') => (dir) => {
  const t1 = join(dir, T1);
  writeFileSync(t1, readFileSync(t1, 'utf8').replaceAll('class="ev ev-observed"', 'class="ev ev-vendor"'));
  put('claims/claude-code-hooks.json', JSON.stringify({ page: '/learn/claude-code-hooks/', claims: recs }, null, 1))(dir);
  inArticle(`<p>A fixture sentence. ${badge}</p>`)(dir);
};
const both = (...fns) => (dir) => fns.forEach((f) => f(dir));

const CASES = [
  // 1. shared chrome
  ['header drift', edit('site/compare/index.html', '<a href="/limits/">Limits</a>', '<a href="/limits/">Limit</a>'), 'header differs'],
  ['footer drift', edit('site/limits/index.html', 'Your supporting cast', 'Supporting cast'), 'footer differs'],
  ['wrong aria-current', edit(T1, 'aria-current="true"', 'aria-current="page"'), 'nav must mark exactly /learn/'],
  ['missing skip link', edit('site/agents/index.html', '<a class="skip" href="#main">', '<a class="skip" href="#top">'), 'missing skip link'],
  // 2. head, sitemap, headers
  ['missing lang', edit('site/limits/index.html', '<html lang="en">', '<html>'), 'missing <html lang="en">'],
  ['missing favicon', edit('site/limits/index.html', /<link rel="icon"[^>]*>/, ''), 'must link the favicon'],
  ['short description', edit('site/compare/index.html', /<meta name="description" content="[^"]+">/, '<meta name="description" content="Too short.">'), 'meta description must be'],
  ['wrong canonical', edit('site/agents/index.html', 'https://crossingguard.dev/agents/"', 'https://crossingguard-site.pages.dev/agents/"'), 'canonical must be'],
  ['sitemap drift', edit('site/sitemap.xml', /\s*<url><loc>https:\/\/crossingguard\.dev\/limits\/<\/loc><\/url>/, ''), 'must list exactly the indexable pages'],
  ['sitemap lastmod drift', edit('site/sitemap.xml', /(claude-code-hooks\/<\/loc><lastmod>)[^<]+/, '$12020-01-01'), 'lastmod for /learn/claude-code-hooks/'],
  ['robots sitemap', edit('site/robots.txt', 'Sitemap:', 'Site-map:'), 'must name the sitemap'],
  ['weakened CSP', edit('site/_headers', "default-src 'none'", 'default-src *'), 'must send exactly "Content-Security-Policy'],
  ['missing X-Frame-Options', edit('site/_headers', /\n\s*X-Frame-Options: DENY/, ''), 'must send exactly "X-Frame-Options'],
  ['headers moved off /*', edit('site/_headers', /^\/\*$/m, '/learn/*'), 'missing the /* rule'],
  ['header redefined', append('site/_headers', '\n/learn/*\n  Content-Security-Policy: default-src *\n'), 'redefined on /learn/*'],
  // 3. links and resources
  ['inline handler', inMain('site/limits/index.html', '<details open onclick="x()"><summary>x</summary></details>'), 'inline event handler'],
  ['inline handler after > in value', inMain('site/limits/index.html', '<a title="a>b" onclick="x()" href="/">x</a>'), 'inline event handler'],
  ['inline script', inMain('site/agents/index.html', '<script>alert(1)</script>'), 'executable inline <script>'],
  ['external image', inMain('site/compare/index.html', '<img src="https://example.com/x.png" alt="">'), 'external resource'],
  ['external srcset', inMain('site/compare/index.html', '<img src="/assets/favicon.svg" srcset="https://example.com/x.png 2x" alt="">'), 'external resource'],
  ['css import', append('site/assets/site.css', '\n@import url(https://example.com/x.css);\n'), 'must not import'],
  ['broken link', edit('site/learn/index.html', 'href="/learn/claude-code-hooks/"', 'href="/learn/claude-code-hook/"'), 'broken link'],
  ['wrong-case link', inMain('site/index.html', '<a href="/Compare/">x</a>'), 'broken link'],
  ['dot-dot link', inMain('site/index.html', '<a href="/../README.md">x</a>'), '. or .. segments'],
  ['broken fragment', inMain('site/index.html', '<a href="/compare/#nope">x</a>'), 'broken fragment'],
  ['.html href', inMain('site/index.html', '<a href="/compare/index.html">x</a>'), 'link to the clean URL'],
  ['directory without slash', inMain('site/index.html', '<a href="/compare">x</a>'), 'directory links end in "/"'],
  ['style guide linked', inMain('site/index.html', '<a href="/styleguide/">x</a>'), 'must stay unlinked'],
  // 4. structure
  ['two h1', inMain('site/limits/index.html', '<h1>Again</h1>'), 'exactly one <h1>'],
  ['heading jump', inMain('site/limits/index.html', '<h2>x</h2><h4>y</h4>'), 'heading level jumps'],
  ['duplicate id', inMain('site/index.html', '<p id="release-status">x</p>'), 'duplicate id="release-status"'],
  ['pre not focusable', edit(T1, /<pre tabindex="0"/, '<pre'), 'tabindex="0"'],
  ['pre unnamed', edit(T1, / aria-labelledby="[^"]+"/, ''), 'named by its figcaption'],
  // 5. articles and claims
  ['toc mismatch', edit(T1, /<li><a href="#codex">[^<]*<\/a><\/li>/, ''), 'contents ['],
  ['unknown badge kind', edit(T1, 'class="ev ev-vendor"', 'class="ev ev-maybe"'), 'exactly one known kind'],
  ['missing not-verified', edit(T1, 'id="not-verified"', 'id="gaps"'), 'id="not-verified"'],
  ['bad JSON-LD', edit(T1, '"@type": "TechArticle"', '"@type": "Article"'), 'JSON-LD @type'],
  ['expired review-by', null, 'has passed', { CHECK_TODAY: '2026-11-30' }],
  ['card without date', edit('site/learn/index.html', / · verified \d{4}-\d{2}-\d{2}<\/p>/, '</p>'), 'every tutorial card needs'],
  ['card date drift', edit('site/learn/index.html', / verified 2026-09-25<\/p>/, ' verified 2026-09-24</p>'), 'card for /learn/claude-code-hooks/'],
  ['claim without record', claimFixture([record({ id: 'fx-other' })], '<span class="ev ev-source" data-claim="fx-1">In source</span><span class="ev ev-source" data-claim="fx-other">x</span>'), 'has no record'],
  ['claim id followed by attribute', claimFixture([record()], '<span class="ev ev-source" data-claim="fx-1">x</span><span class="ev ev-source" data-claim="fx-nope" title="t">x</span>'), 'data-claim="fx-nope" has no record'],
  ['unreferenced record', claimFixture([record(), record({ id: 'fx-2' })]), 'not referenced by any badge'],
  ['badge stronger than record', claimFixture([record()], '<span class="ev ev-observed" data-claim="fx-1">Observed</span>'), 'stronger than its record'],
  ['claim badge without id (class order)', both(claimFixture(), inArticle('<p>x <span class="ev-observed ev">Observed</span></p>')), 'badge without data-claim'],
  ['claim badge without id (lede)', both(claimFixture(), edit(T1, '<p class="lede">', '<p class="lede"><span class="ev ev-observed">Observed</span> ')), 'badge without data-claim'],
  ['person as owner', claimFixture([record({ owner: 'Jane Doe' })]), 'owner must name a role'],
  ['unknown evidence class', claimFixture([record({ evidence_class: 'vibes' })]), 'evidence_class must be one of'],
  ['future verified_on', claimFixture([record({ verified_on: '2030-01-01', review_by: '2030-01-30' })]), 'not in the future'],
  ['far review_by', claimFixture([record({ review_by: '2028-09-25' })]), 'at most 45 days'],
  ['marketing claim without record', both(put('claims/marketing.json', JSON.stringify({ claims: [record({ id: 'mk-1' })] })), inMain('site/index.html', '<span data-claim="mk-1">x</span><span data-claim="mk-nope">y</span>')), 'no record in claims/marketing.json'],
  // 6. banned absolutes
  ['banned absolute', inMain('site/agents/index.html', '<p>A tamper-proof boundary.</p>'), 'banned absolute'],
  ['banned absolute in description', edit('site/index.html', /(<meta name="description" content=")/, '$1Guaranteed. '), 'banned absolute'],
  ['banned absolute in aria-label', inMain('site/index.html', '<div aria-label="complete visibility">x</div>'), 'banned absolute'],
  ['quoted term outside style guide', inMain('site/agents/index.html', '<p>We avoid <q class="term">complete visibility</q>.</p>'), 'banned absolute'],
  // 7. voice
  ['voice: dash', inArticle('<p>The hook runs — then exits.</p>'), 'voice: dash'],
  ['voice: not-X-but-Y', inArticle('<p>It is not just a logger but a guard.</p>'), 'not-X-but-Y'],
  ['voice: staged run-up', inArticle("<p>Here's the thing: hooks are fast.</p>"), 'staged run-up'],
  ['voice: stock word', inArticle('<p>We delve into hooks.</p>'), 'stock AI word'],
  ['voice: bold label list', inArticle('<ul><li><b>Speed:</b> fast.</li></ul>'), 'bold label'],
  ['voice: bold label list (period form)', inArticle('<ul><li><b>Speed.</b> It is fast.</li></ul>'), 'bold label'],
  ['voice: adjacent contrast', inArticle("<p>A hook isn't a policy engine. It's a program.</p>"), 'contrast'],
  ['voice: chatbot residue', inArticle('<p>I hope this helps.</p>'), 'chatbot residue'],
  ['voice: authoring guide', append('TUTORIALS.md', '\nLet\'s dive in.\n'), 'staged run-up'],
  // 8. public safety
  ['home path', append('TUTORIALS.md', '\nPath /Users/alice/x\n'), 'home path'],
  ['encoded home folder', append('TUTORIALS.md', '\n~/.claude/projects/-Users-alice-code-app/x.jsonl\n'), 'encoded home path'],
  ['email', append('README.md', '\nContact someone@example.com\n'), 'email address'],
  ['loopback port', append('README.md', '\nOpen 127.0.0.1:8123\n'), 'loopback port'],
  ['uuid', inMain('site/limits/index.html', '<p>123e4567-e89b-12d3-a456-426614174000</p>'), 'UUID'],
  ['long hex', inMain('site/limits/index.html', '<p>0123456789abcdef0123456789abcdef</p>'), 'long hex run'],
  ['api key', append('TUTORIALS.md', '\nsk-abcdefghijklmnop\n'), 'API key shape'],
  ['short product name', append('README.md', '\nRun cg check\n'), 'short product name'],
  ['short product name, upper case', append('README.md', '\nRun CG-server\n'), 'short product name'],
  ['unlisted extension', put('examples/watch.py', '# /Users/alice/hooks\n'), 'home path'],
  ['stray OS file', put('site/.DS_Store', 'x'), 'remove this file'],
  // 9. contrast
  ['text contrast', edit('site/assets/site.css', '--ink-3:#656B71;', '--ink-3:#AAAAAA;'), 'below 4.5:1'],
  ['later :root override', append('site/assets/site.css', '\n:root{--ink-3:#B0B0B0}\n'), 'below 4.5:1'],
  ['focus contrast', edit('site/assets/site.css', '--focus-on-dark:#DDF03A;', '--focus-on-dark:#0B5FA5;'), 'below 3:1'],
];

// Technical prose that must pass: each is a sentence the voice rules must not flag.
const POSITIVE = [
  ["ordinary 'isn't … it's'", inArticle("<p>If the hook isn't trusted, it's skipped.</p>")],
  ['en dash in a number range', inArticle('<p>Values from 1–4 are accepted.</p>')],
  ['technical key', inArticle('<p>Add the <code>hooks</code> key to the settings file.</p>')],
  ['deep dive label', edit(T1, '<p class="eyebrow">Tutorial', '<p class="eyebrow">Deep dive')],
  ["'the thing is' inside a sentence", inArticle('<p>Say what the thing is before you configure it.</p>')],
];

const run = (dir, env = {}, args = []) => spawnSync(process.execPath, ['scripts/check-site.mjs', ...args], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-site-'));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes('.git') });
  return dir;
};

let bad = 0;
const report = (ok, name, out) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : '\n' + out.trim().split('\n').slice(0, 6).map((l) => '        ' + l).join('\n')}`); };

// The unmodified tree must pass, or every case below proves nothing.
{
  const dir = copy();
  const r = run(dir);
  report(r.status === 0, 'baseline passes', r.stdout + r.stderr);
  if (r.status !== 0) { console.error('baseline fails: fix the site before trusting the self-test'); process.exit(1); }
  const fx = copy();
  claimFixture()(fx);
  const f = run(fx);
  report(f.status === 0, 'claim fixture alone passes', f.stdout + f.stderr);
  rmSync(dir, { recursive: true, force: true }); rmSync(fx, { recursive: true, force: true });
}

for (const [name, mutate] of POSITIVE) {
  const dir = copy();
  try { mutate(dir); const r = run(dir); report(r.status === 0, `passes: ${name}`, r.stdout + r.stderr); }
  catch (e) { report(false, `passes: ${name}`, e.message); }
  rmSync(dir, { recursive: true, force: true });
}

for (const [name, mutate, expect, env] of CASES) {
  const dir = copy();
  try {
    if (mutate) mutate(dir);
    const r = run(dir, env);
    const out = r.stdout + r.stderr;
    report(r.status === 1 && out.includes(expect), name, `exit ${r.status}; expected "${expect}"\n${out}`);
  } catch (e) { report(false, name, e.message); }
  rmSync(dir, { recursive: true, force: true });
}

// Freshness modes, in a scratch git repository with every date expired.
{
  const dir = copy();
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const expired = { CHECK_TODAY: '2026-11-30' };
  const warn = run(dir, expired, ['--freshness=warn']);
  report(warn.status === 0 && /warning/.test(warn.stdout + warn.stderr), 'expired + warn passes with a warning', warn.stdout + warn.stderr);
  const untouched = run(dir, expired, ['--freshness=changed', '--base', 'HEAD']);
  report(untouched.status === 0, 'expired + changed, nothing changed: passes', untouched.stdout + untouched.stderr);
  const t1 = join(dir, T1);
  const orig = readFileSync(t1, 'utf8');
  const change = (from, to) => { const next = orig.replace(from, to); if (next === orig) throw new Error(`freshness fixture anchor not found: ${from}`); writeFileSync(t1, next); };
  change(/\n\s*<p>Restart OpenCode after [^<]*<\/p>/, '');
  const removal = run(dir, expired, ['--freshness=changed', '--base', 'HEAD']);
  report(removal.status === 0, 'expired + changed, removal-only: passes', removal.stdout + removal.stderr);
  change(/Restart OpenCode after [^<.]*\./, 'Restart OpenCode twice after changing a plugin.');
  const reword = run(dir, expired, ['--freshness=changed', '--base', 'HEAD']);
  report(reword.status === 1, 'expired + changed, reworded prose on a badged page: fails', reword.stdout + reword.stderr);
  writeFileSync(t1, orig);
  change(/Restart OpenCode after [^<.]*\./, 'Restart OpenCode after editing a plugin file.');
  git('add', '-A');
  const staged = run(dir, expired, ['--freshness=changed', '--base', 'HEAD']);
  report(staged.status === 1, 'expired + changed, staged edit: fails', staged.stdout + staged.stderr);
  rmSync(dir, { recursive: true, force: true });
}

const total = CASES.length + POSITIVE.length + 7;
console.log(`\ncheck-site self-test: ${total - bad}/${total} behaved as expected`);
process.exit(bad ? 1 : 0);

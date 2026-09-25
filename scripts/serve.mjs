#!/usr/bin/env node
// Local preview that behaves like Cloudflare Pages for this site, so what you test
// here is what the preview deployment will do. Node built-ins only.
//
//   node scripts/serve.mjs [--port 8000] [--no-js]
//
// Emulated: /x/ serves x/index.html; /x redirects to /x/ when that is a directory;
// /x/index.html and /x.html redirect to their clean URL; a missing path gets the
// nearest 404.html with status 404; site/_headers rules are applied (splats, and
// several matching rules combine). --no-js replaces script-src with 'none' so
// JavaScript-off journeys can be tested in a normal browser.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]) || 8000;
const noJs = argv.includes('--no-js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

function headerRules() {
  const file = join(ROOT, '_headers');
  if (!existsSync(file)) return [];
  const rules = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push({ re: new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), headers: [] });
    else { const i = line.indexOf(':'); rules.at(-1)?.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
  }
  return rules;
}

function send(res, status, path, body, type, extra = {}) {
  const headers = { 'Content-Type': type, ...extra };
  for (const rule of headerRules()) if (rule.re.test(path)) for (const [k, v] of rule.headers) headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  if (noJs && headers['Content-Security-Policy']) headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace(/script-src [^;]+/, "script-src 'none'");
  res.writeHead(status, headers);
  res.end(body);
}
const redirect = (res, to) => send(res, 308, to, '', 'text/plain', { Location: to });
// Cloudflare paths are case-sensitive; macOS is not. Compare each segment exactly.
const exact = (p) => {
  let dir = ROOT;
  for (const seg of p.slice(ROOT.length).split('/').filter(Boolean)) {
    if (!existsSync(dir) || !statSync(dir).isDirectory() || !readdirSync(dir).includes(seg)) return false;
    dir = join(dir, seg);
  }
  return true;
};
const file = (p) => existsSync(p) && exact(p) && statSync(p).isFile();
const RESERVED = new Set(['_headers', '_redirects', '_routes.json', '_worker.js']); // Cloudflare does not serve these

createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return send(res, 400, '/', 'bad request', 'text/plain'); }
  const disk = normalize(join(ROOT, path));
  if (!disk.startsWith(ROOT)) return send(res, 400, path, 'bad path', 'text/plain');
  if (path.endsWith('/index.html')) return redirect(res, path.slice(0, -'index.html'.length) + url.search);
  if (path.endsWith('.html') && path !== '/404.html') return redirect(res, path.slice(0, -'.html'.length) + url.search);
  if (path.endsWith('/index')) return redirect(res, path.slice(0, -'index'.length) + url.search);
  if (path.endsWith('/') && file(join(disk, 'index.html'))) return send(res, 200, path, readFileSync(join(disk, 'index.html')), TYPES['.html']);
  if (!path.endsWith('/') && file(join(disk, 'index.html'))) return redirect(res, path + '/' + url.search);
  if (file(disk) && !RESERVED.has(path.split('/').pop())) return send(res, 200, path, readFileSync(disk), TYPES[extname(disk)] || 'application/octet-stream');
  if (file(disk + '.html')) return send(res, 200, path, readFileSync(disk + '.html'), TYPES['.html']);
  // nearest 404.html up the tree
  for (let dir = dirname(disk); dir.startsWith(ROOT); dir = dirname(dir)) {
    if (file(join(dir, '404.html'))) return send(res, 404, path, readFileSync(join(dir, '404.html')), TYPES['.html']);
    if (dir === ROOT) break;
  }
  send(res, 404, path, 'not found', 'text/plain');
}).listen(port, '127.0.0.1', () => console.log(`serving site/ like Cloudflare Pages on port ${port}${noJs ? ' (JavaScript disabled by CSP)' : ''}`));

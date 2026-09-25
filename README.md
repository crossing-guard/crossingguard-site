# crossingguard-site

Marketing website for Crossing Guard, an open source control layer for AI coding agents.
Served at https://crossingguard.dev by Cloudflare Pages. There is no build step: Pages
publishes the `site/` directory as it is.

## Layout

| Path | What it is |
| --- | --- |
| `site/` | Everything that is served, and nothing else |
| `site/index.html`, `site/agents/`, `site/compare/`, `site/limits/` | Marketing pages |
| `site/learn/` | The Learn hub, plus one directory per tutorial |
| `site/styleguide/` | Component reference for contributors. Not linked, not indexed |
| `site/404.html` | Served by Cloudflare Pages for any missing path |
| `site/assets/` | `site.css` (the only stylesheet), `legacy-hash.js` (the only script), favicon |
| `site/_headers`, `site/robots.txt`, `site/sitemap.xml` | Response headers, crawler rules, page list |
| `scripts/check-site.mjs` + `check-site.config.json` | The site check (Node 20+, no dependencies) |
| `scripts/check-site.test.mjs` | Proves every check rule fails on a planted defect |
| `scripts/prose-invariants.mjs` | Confirms that a prose edit left labels, code, links and numbers unchanged |
| `scripts/serve.mjs` | Local preview that behaves like Cloudflare Pages |
| `templates/tutorial.html` | Skeleton to copy for a new tutorial |
| `claims/` | Evidence records for claims about Crossing Guard itself (added with the first page that makes one) |
| `TUTORIALS.md` | How to write a tutorial |

Every page repeats the same header and footer markup between `<!-- site-header -->` and
`<!-- site-footer -->` markers. Only `aria-current` differs. The check fails if any copy
drifts, so edit the block once and paste it into every page.

## Working on the site

```bash
node scripts/check-site.mjs           # must pass before every commit
node scripts/check-site.test.mjs      # the check's own self-test
node scripts/serve.mjs --port 8000    # preview with Cloudflare Pages behaviour and headers
node scripts/serve.mjs --no-js        # the same, with JavaScript disabled by policy
```

## Publishing

1. Work on a branch and open a pull request. Cloudflare Pages builds a preview deployment
   for the branch, and the `check` workflow runs the site check.
2. Review the preview in a browser.
3. Merging to `main` deploys production.

The `check` workflow reports on pull requests, but it cannot stop Cloudflare from
deploying. Cloudflare deploys independently of GitHub Actions. Protect `main` and require
the check, or make the check the Cloudflare build command
(`node scripts/check-site.mjs --freshness=warn`).

Before each push, maintainers also run a private pre-publication scan that is not part of
this repository.

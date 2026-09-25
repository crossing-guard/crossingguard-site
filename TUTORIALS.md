# Writing a tutorial

Tutorials live at `site/learn/<slug>/index.html`. They explain how AI coding agents behave,
and they are only worth reading if every claim holds up. This guide sets out what a tutorial
must contain. The component reference is the unlinked `/styleguide/` page, which you can open
through `node scripts/serve.mjs`.

## Audience

Write for a developer who uses Claude Code, Codex or OpenCode every day and wants to know what
happens underneath. Explain the mechanism before the product. If a reader could do something
without Crossing Guard, show them how, and mention the product only where it adds something.

## Voice

Write the way a careful engineer explains something to a colleague: plain sentences, the
specific fact, and no performance. These rules come from Wikipedia's "Signs of AI writing"
(WikiProject AI Cleanup) and the Humanizer skill (MIT licence), restated here in our own words.

State the point instead of staging it:

- Don't set up a contrast that nobody raised ("not just X but Y", "it isn't X. It's Y"). State
  what it is. Keep a contrast only when the reader really believes the first half.
- Don't end a paragraph with a short line that repeats it, and don't build a paragraph toward a
  punch line.
- Don't open with a run-up such as "here's the thing" or "let's dive in". Start with the fact.
- Don't answer an objection that no one made.

Let the meaning set the rhythm:

- Use no dashes in tutorial prose. Use a period, comma, colon or parentheses instead. An en
  dash in a number range (1–4) is fine.
- List three things only when there are three things.
- Vary sentence length the way ordinary writing does.

Don't inflate:

- Avoid stock words such as "delve", "pivotal", "crucial", "seamless", "showcase" and
  "testament".
- Don't call an ordinary detail a turning point, or attach "highlighting …" or
  "underscoring …" to a plain fact.
- Use "is", "are" and "has" rather than "serves as" or "boasts".
- Don't sell. A tutorial describes; it doesn't advertise.

Format by need:

- Don't open list items with a bold label. Write the item as a sentence, or turn the list into
  a paragraph.
- Use sentence-case headings that say what the section covers.
- Straight quotes are fine.

Two rules that the others don't cover:

- Every sentence must add something the reader didn't already have.
- Never add a fact to make a sentence read better. If a sentence needs a detail you don't
  have, write a simpler sentence.

`scripts/check-site.mjs` flags the mechanical signs in tutorial prose: dashes, the
"not just … but" and "isn't … It's" contrasts, run-ups, a short list of stock words, bold list
labels and chatbot phrases. Triads, closers, inflation and sales language need a person, so
the reviewer looks for those. When a tutorial is edited, run
`node scripts/prose-invariants.mjs <before> <after>`. It confirms that labels, code, links,
heading ids and every number, version and date are unchanged.

Never use absolutes such as "tamper-proof", "prevents all leaks", "complete visibility",
"never sends", "secure" or "guaranteed". The check rejects them.

## Required parts

Copy `templates/tutorial.html` and keep these parts in this order:

1. A breadcrumb (`Home › Learn › <short title>`), an eyebrow, an `<h1>` and a lede. Start the
   eyebrow with `Tutorial` for something a reader can do today, or with `Deep dive` for
   pre-release internals.
2. The verified-on panel: exact runtime versions, the operating system, the date you read the
   vendor documentation, and the evidence legend.
3. The "On this page" list, which must list every `<h2 id>` in the article, in order.
4. The sections. Each one is a `<section>` with an `<h2 id>`, and uses `<h3>` below that
   rather than skipping to `<h4>`.
5. A "What we haven't verified" section (`id="not-verified"`) whenever anything is marked
   Not verified.
6. Series navigation, and the line `Last verified YYYY-MM-DD · review by YYYY-MM-DD`.

In `<head>`:

- remove the template's robots `noindex` meta;
- add a `meta description` of 50 to 170 characters;
- add a canonical link to `https://crossingguard.dev/learn/<slug>/`;
- set `verified-on`, `review-by` (at most 45 days later, usually 30) and `tested-versions`;
- set the JSON-LD `dateModified` to the `verified-on` date.

Then add the page to `site/sitemap.xml` with a `lastmod` equal to `verified-on`, to the Learn
hub (the card's "verified" date must match), and to the footer's Learn column on every page.
Each code block's `<pre>` needs `tabindex="0"` and an `aria-labelledby` that points at its
figcaption.

## Evidence labels

Put a label straight after each factual sentence:

| Label | Class | Use it when |
| --- | --- | --- |
| Observed | `ev ev-observed` | You ran it on a real install at the stated versions. |
| In source (not yet public) | `ev ev-source` | You read it in the product code but did not exercise it. |
| Vendor docs | `ev ev-vendor` | The vendor's current documentation says so. Link the page at the end of the article. |
| Not verified | `ev ev-unverified` | You believe it but have not confirmed it. Explain it under "What we haven't verified". |

Advice and explanation carry no label. If a claim can't carry an honest label, weaken it or
remove it.

## Claims about Crossing Guard itself

A fact about how a vendor's tool behaves needs only a label. A claim about Crossing Guard also
needs a record:

- Put the record in `claims/<slug>.json` (or `claims/marketing.json` for Home and Agents),
  which sits outside `site/` and is not served.
- Give the badge `data-claim="<id>"`.
- Each record holds:
  - `id` and `wording`;
  - `evidence_class`: one of "installed observation", "source-verified behavior" or
    "vendor statement";
  - `strength`: enforced, best-effort, advisory, observed or planned;
  - `versions`, `verified_on` and `review_by`;
  - `owner`, which names a role such as "Crossing Guard maintainers", never a person;
  - either `evidence_link` or `evidence_private_reason`.

A badge may not be stronger than its record. For example, an Observed badge needs a record
whose class is "installed observation". The check fails on a badge without a record, on a
record that no badge uses, and on a badge stronger than its record.

## Keeping it true

`review-by` is enforced:

- Locally, and in the weekly scheduled run, an expired page fails the check.
- On a pull request, an expired page fails only if the change adds or edits lines on it (or in
  its claims file). A change that only deletes lines always passes, so removing a stale claim
  is never blocked.

To re-verify, test against the newest vendor versions, then update the verified-on panel, the
text, the labels and both dates. When a vendor changes something, fix the page and its dates
in the same commit.

## Public safety

The files under `site/` are published, and everything in this repository is public on
GitHub. Never include:

- personal paths, account names, email addresses, or session or record identifiers;
- tokens, keys, loopback ports with a number, or long hexadecimal identifiers;
- memory records, transcripts or logs from a real install;
- internal project names.

For home directories use the `/Users/you/` or `/home/you/` placeholder, use `/path/to/...` for
other paths, and label invented examples as illustrative. Figures from our own install need
the owner's approval and a recorded query with its denominators before they are published. By
default, describe them in words ("most", "a small share").

Code blocks use `<figure class="code">`, are captioned with the file or shell, and escape `<`,
`>` and `&`. Never show command output that you did not see.

## Before you commit

```bash
node scripts/check-site.mjs
node scripts/check-site.test.mjs
```

Then preview the page with `node scripts/serve.mjs`, and check it at phone width, with the
keyboard alone, and with `--no-js`.

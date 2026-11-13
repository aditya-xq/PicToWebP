# Revamping the PicToWebP site: research notes and plan

Status: research draft, November 2026.
Scope: `web-ts/` (both build profiles) plus the new public artifacts an
agent-facing, local-first tool site needs.

## 1. Diagnosis: it is a converter page, not a tool site

The current deploy is one screen: a hero, capabilities chips, a quality
control, a drop zone, a results panel, a footer. It is a very good converter
page. It is not yet a website for a tool, because nothing on it answers the
three questions a developer arrives with:

1. "Can I run this on my machine, and what do I type?" There is no install
   command anywhere on the page. The only link is *Star on GitHub*.
2. "Which edition am I looking at?" The header says *Browser Edition* with no
   explanation that a Python server edition and a Rust CLI exist, or how they
   differ.
3. "Can my agent use it?" The repository already ships an agent contract, an
   installable skill and a Rust MCP server, and the site surfaces none of it.

Everything below is aimed at those three questions, without weakening the
privacy guarantees in `AGENTS.md`.

## 2. What the 2026 web actually expects from a tool site

### 2.1 `/llms.txt`, but at a subpath, and with markdown twins

`llms.txt` v2 (revision dated 10 August 2026) is still a community proposal,
not a standard, and Google Search does not read it. Its documented, measured
use is coding agents reading developer documentation. Two properties matter
for this project:

- **A file may live at any path and covers the URLs under that path.** The
  proposal calls out the GitHub Pages project-site case explicitly: a project
  site "can publish files in its own directory but can never add one to the
  host's `/.well-known/`". So the correct location here is
  `https://aditya-xq.github.io/PicToWebP/llms.txt`, not a root file.
- **Pages should have a markdown twin**, at the same URL with `.md` appended
  (`page.html.md`) or the extension replaced. Advertise the pair with
  `rel="alternate" type="text/markdown"` and `rel="describedby"` pointing at
  the `llms.txt` that covers the page.

Format rules (Lighthouse validates these, see 2.4): optional BOM, an H1 with
the project name, a blockquote summary, then free prose, then H2 sections
whose bodies are markdown lists of `[name](url): note`. A by-convention
"Optional" section holds links an agent can skip.

Why the exact format is load-bearing rather than cosmetic: the Lighthouse
`llms-txt` audit passes on a **malformed** file only if every check passes. A
present-but-invalid file scores worse than no file at all, because a 404 is
treated as "not applicable" while a bad file is a failure.

Also worth shipping: `llms-full.txt`, the single-file concatenation of the
docs, for agents that would rather take one big fetch than follow links.

### 2.2 Agent Skills discovery via `/.well-known/agent-skills/index.json`

This is the mechanism that lets a single command install your instructions
into whatever agent the user runs:

```bash
npx skills add https://aditya-xq.github.io/PicToWebP/
```

`vercel-labs/skills` (the `npx skills` CLI, MIT, Node 22.20+) resolves sources
from GitHub, any git URL, a local path, or **a URL that publishes a discovery
index**. The index is specified by Cloudflare's Agent Skills Discovery RFC, a
proposal layered on RFC 8615:

```
/.well-known/agent-skills/index.json
{
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [
    {
      "name": "pictowebp",
      "type": "skill-md",
      "description": "Convert images and folders to WebP locally...",
      "url": "/.well-known/agent-skills/pictowebp/SKILL.md",
      "digest": "sha256:..."
    }
  ]
}
```

Details that decide whether discovery works:

- `$schema` is required; clients must refuse an unrecognised version.
- Each entry needs `name`, `type` (`skill-md` or `archive`), `description`,
  `url`, and `digest` (`sha256:` + 64 hex chars).
- URLs resolve relative to the index URL. Clients probe the **path-relative**
  location first, then the origin root, and accept the legacy
  `/.well-known/skills/` name as a fallback. That is what makes a GitHub Pages
  project site workable: publish under `/PicToWebP/.well-known/agent-skills/`.
- Serve `index.json` as `application/json`, `SKILL.md` as `text/markdown`.
- Prefer `type: "skill-md"` with a fetchable `SKILL.md`. It keeps
  progressive disclosure intact (`SKILL.md` plus optional
  `references/*.md` fetched only when needed) and needs no archive tooling.

The repository already has `agent/pictowebp/SKILL.md` and a JSON schema
directory. Publishing them as static files under the site is mostly a copy
step in the build.

### 2.3 ARD: `/.well-known/ard.json` plus `<link rel="ard">`

Agentic Resource Discovery (v0.91, 26 August 2026) is the successor to
`ai-catalog.json`; Lighthouse 13.5 validates it. It is a domain-level catalog
of *agentic resources* — the natural place to declare "this project has a CLI,
an MCP server and a skill, here is where each lives".

Discovery order per spec section 5.1: an `Agentmap:` directive in
`robots.txt`, then `<link rel="ard" href="...">`, then an HTTP
`Link: <...>; rel="ard"` header, then `/.well-known/ard.json`. Because a
project site cannot own the origin root, the `<link rel="ard">` route is the
portable one.

Minimum shape:

```json
{
  "entries": [
    {
      "identifier": "urn:air:aditya-xq.github.io:pictowebp:cli",
      "displayName": "PicToWebP CLI",
      "type": "application/octet-stream",
      "url": "https://github.com/aditya-xq/PicToWebP",
      "description": "...",
      "tags": ["image", "webp", "cli", "offline"],
      "capabilities": ["convert_folder", "convert_file"]
    }
  ]
}
```

Rules: every entry needs `identifier` (URN matching
`^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$`), `displayName`, `type` (a
well-formed media type; `application/mcp-server-card+json` for the MCP
server), and exactly one of `url` or `data`. No top-level `collections`.
`capabilities` is optional, unscored, and useful for registry filtering.

Reality check, so effort is proportional: no registry is documented to read
`ard.json` today, and the audit is "not applicable" when no manifest exists.
Treat this as cheap future-proofing, not a traffic strategy.

### 2.4 Lighthouse Agentic Browsing rewards a sound page, not jumps through hoops

Lighthouse 13.3 added an experimental `agentic-browsing` category; 13.5 has
seven audits, of which three count toward the ratio:

| Audit | What it measures | Notes |
| --- | --- | --- |
| `agent-accessibility-tree` | programmatic names, labels, real buttons | fixes overlap with normal a11y work |
| cumulative layout shift | content not moving under an agent's click target | |
| `llms-txt` | `/llms.txt` exists **and** is well-formed | 404 = N/A, malformed = fail |
| WebMCP (3 audits) | registered tools, form coverage, schema validity | needs origin trial |
| `ard.json` | manifest schema validity | only when a manifest is found |

There is no 0-100 score, the category is experimental, and it affects
nothing in Search. The practical lesson is narrower and still worth taking:
**a page whose controls are all real labelled elements with a stable layout,
and whose `llms.txt` is correctly formatted, is already near the ceiling.**
Our drop zones are keyboard-operable and the toasts use `aria-live`, so this
is mostly a verification exercise, not a redesign driver.

### 2.5 CLI + skill beats MCP on context cost, and both beat nothing

The consistent finding across practitioner write-ups: an MCP server with many
tools dumps every schema into the context window the moment it connects, while
a `SKILL.md` is read once and teaches the agent to call a CLI it already has
terminal access to. The recommended default for a local, single-purpose tool:

1. make the CLI correct and self-describing (`--help`, `--json`, exit codes);
2. ship a small `SKILL.md` that names the three or four commands that matter;
3. offer MCP only where runtime tool discovery actually helps.

PicToWebP is already in the right shape: `docs/agent-contract.md` is
normative, both editions implement `--json`/`--info`/`--dry-run`/exit-code
parity, and Rust ships a stdio `--mcp` server exposing `info` and `convert`.
The website's job is to make that discoverable and copy-pasteable rather than
to invent a third integration path.

### 2.6 Quickstart pages get finished when the first block is copy-pasteable

From quickstart-writing practice, the structure that survives contact with
developers:

- one sentence: what it does, what it runs on, who it is for;
- prerequisites before step 1, with pinned versions;
- one command per block, no `$` prompt inside the block (it breaks copy
  buttons), with the expected output underneath;
- the smallest thing that works, producing something visible;
- a verify step (`pictowebp --version`);
- a troubleshooting table of real error → real fix.

Two more findings worth acting on:

- Show the install command **above the fold** with a copy button that flips
  to "Copied". For a CLI tool this is the highest-value pixel on the page.
- Offer per-platform and per-manager variants (uvx, pipx, winget, scoop,
  brew, direct binary). Guessing wrong sends people to step 4 confused.

## 3. The local-run story is the real blocker

`https://pypi.org/pypi/pictowebp/json` returns 404 as of 13 November 2026, so
there is no published `pictowebp` distribution. That means the single most
convenient local-run path does not exist yet:

```bash
uvx pictowebp-web        # what users would expect to work
pipx install pictowebp
```

A website section that says "run it locally" while the package is absent sends
people to a `pip install` error, which is worse than saying nothing. Publishing
to PyPI is a prerequisite for the site work, not a nice-to-have. Rust already
has the stronger story (six signed targets, `SHA256SUMS`, `latest.json`,
attestations, installers), so the site should lead with whichever path is real.

Recommended ladder, cheapest first:

1. **Zero-install browser edition** — already live, stays the default.
2. **`uvx pictowebp-web`** — one command, no Python management, opens the same
   UI on `127.0.0.1`. Requires the PyPI release.
3. **`pipx install pictowebp` / `uv tool install pictowebp`** — persistent CLI.
4. **Rust binary** — no runtime at all, signed archives per platform.
5. **Package managers** — `winget`, `scoop`, `brew` tap. Real work, real
   payoff for discoverability.

## 4. Proposed information architecture

One SPA, as `AGENTS.md` requires, but with real sections instead of one
screen. The conversion app stays the default view; everything else is a
section below it, addressable by hash so links and agents can point at them.

```
/                     Convert          the app, unchanged, first thing you see
#local                Run it locally   install tabs + copy buttons + verify
#agents               For agents       skill install, MCP config, llms.txt links
#editions             Editions         browser vs python vs rust, one table
#privacy              Privacy          the guarantees, stated plainly
#docs                 CLI reference    flags table, JSON schema, exit codes
```

Design notes:

- **Keep the app first.** The revamp must not turn a working tool into a
  marketing page. Drop zone stays above the fold on mobile.
- **One install command, tabs for the rest.** Default tab detected from
  `navigator.userAgent` for the platform, never from network calls.
- **Every code block is copyable** and every one has expected output under it.
- **No new dependencies** for tabs or copy buttons. `addEventListener` only,
  per the CSP rule.
- **Link the markdown twins** from each section: `rel="alternate"
  type="text/markdown"` links plus a visible "read this page as markdown" that
  agents and humans both use.

## 5. What Phase 1 publishes

The repository already had `llms.txt` and an `agent/` catalog, and the deploy
workflow already copied both into `dist/`. What was missing was the discovery
layer around them, and a guarantee that the copies stay valid. Phase 1 adds one
build step, `web-ts/build/agent-surfaces.ts`, plus
`web-ts/scripts/validate-agent-surfaces.mjs`, which now runs as part of
`npm run build`.

| Published path | Source | Notes |
| --- | --- | --- |
| `/llms.txt` | repo-root `llms.txt` | **rewritten**: was non-conformant, now H1 → blockquote → prose → H2 link lists |
| `/llms-full.txt` | generated | contract + skill + all five references, one fetch |
| `/index.html.md` | `web-ts/public/` | markdown twin of the app page |
| `/.well-known/agent-skills/index.json` | generated | v0.2.0 schema, real SHA-256 digest |
| `/.well-known/agent-skills/pictowebp/` | copy of `agent/pictowebp/` | relative links inside `SKILL.md` keep working |
| `/.well-known/ard.json` | generated | two entries: skill and CLI |
| `/agent/` | copy of `agent/` | unchanged, still the opencode catalog path |
| `/agent/agent-contract.md` | `docs/agent-contract.md` | no longer a GitHub blob link |
| `/.nojekyll` | generated | keeps dot-directories safe |
| `<link rel="ard">`, `rel="describedby"`, `rel="alternate" type="text/markdown"` | injected by the plugin | correct for both `base` profiles |

The validator is deliberately strict: it fails the build on a malformed
`llms.txt`, a digest that does not match, an `ard.json` entry that is missing
one of `identifier`/`displayName`/`type`, or a published link pointing at a file
that is not in the artifact. Links resolve with exact case, so a path that only
works on a case-insensitive filesystem fails locally rather than on Pages. When
the repository sources are absent entirely (a vendored `web-ts/`, a stripped
container stage) the generator warns and skips, and the validator skips with it;
the `Dockerfile` copies the sources so the container build still publishes the
full surface.

Two Pages-specific hazards remain worth verifying after the first deploy,
because both fail silently:

1. **Dot-directories actually served.** This one is not hypothetical: the first
   deploy shipped without them. `actions/upload-pages-artifact` excludes every
   top-level dot entry (`--exclude=.[^/]*`) unless `include-hidden-files: true`
   is set, so `.well-known/` was built and verified in `dist/` and then dropped
   at upload. The workflow now sets the flag and re-checks the live URLs after
   deploying.
2. **Base path.** `base: '/PicToWebP/'` means the injected `<link>` tags are
   prefixed correctly, but any hand-written absolute URL inside a manifest still
   has to name the project subpath.

**Two hosts, on purpose.** `web-ts/build/site.mjs` keeps them apart: the build
is published and served from `aditya-xq.github.io/PicToWebP/`, so every
machine-readable URL (`llms.txt`, `ard.json`, the skill) names that host, while
`xqbuilds.com/pictowebp/` is the canonical public page and names itself in
`rel="canonical"`, `og:url`, `og:image`, the JSON-LD `url`, `robots.txt` and
`sitemap.xml`. `xqbuilds` vendors this build into `static/pictowebp/` on every
Vercel deploy via `scripts/sync-pictowebp.mjs`, rewriting publish URLs to its
own host. The validator enforces both halves, so the hosts cannot drift apart
silently.


## 6. Phased plan

### Phase 0 — make "run locally" true (blocks everything else)
- Publish `pictowebp` to PyPI (Trusted Publishing, no token in CI).
- Add a `uvx pictowebp-web` smoke test to the e2e suite.
- Decide whether `pictowebp-web` opens a browser; document the port and
  `--no-open` flag.

### Phase 1 — agent surfaces (done)
- `llms.txt` rewritten to v2 format; `llms-full.txt` and the `index.html.md`
  twin generated into the build.
- `.well-known/agent-skills/index.json` + skill copy step, `.well-known/ard.json`
  + `<link rel="ard">`, in `web-ts/build/agent-surfaces.ts`.
- `web-ts/scripts/validate-agent-surfaces.mjs` gates every build and the deploy
  workflow, so the published copies cannot drift from `agent/` or `llms.txt`.

### Phase 2 — local-run section in the UI
- `#local` with platform tabs, copy buttons, expected output, verify step.
- Editions comparison table driven by the backend capability model, not
  hardcoded prose, so it cannot drift from `backend/capabilities`.
- README install commands become the single source for both.

### Phase 3 — polish and verify
- `npx lighthouse --only-categories=agentic-browsing` on the deployed site.
- Verify dot-directories over HTTPS.
- Add the one-line `npx skills add` command to the README and the hero.

## 7. Deliberate non-goals

- **WebMCP tool registration.** It needs a Chrome origin trial, the Lighthouse
  audits for it are informational, and "agent drops 400 photos into a browser
  drop zone" is not a workflow agents have. Revisit if the trial ships stable.
- **A hosted conversion API.** Directly contradicts the no-network guarantee.
- **An `llms.txt` generated by a template.** 68% of published files are
  templated; the ones that work are hand-written and accurate. Ours is short
  enough to maintain.
- **Any analytics to "measure agent traffic."** These files are read on demand
  by local agents; there is nothing to measure server-side on Pages anyway.
- **Weakening the static CSP** for a font, an icon CDN, or a comment widget.

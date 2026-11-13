# Phase 2 plan: from converter page to tool site

Status: plan, November 2026. Builds on `docs/web-revamp-research.md`.

The agent surface shipped in Phase 1 answers "can my agent use this". Phase 2
answers the other half of the brief: **"can I run this on my machine, and what
do I type?"** Today the page has no install command anywhere.

## 1. Scope decisions

- **The Rust binary is the local story.** PyPI publishing is out of scope, so
  nothing on the page advertises `pip install pictowebp`, `uvx pictowebp-web`
  or `pipx`. Python stays documented as a from-source path for contributors,
  not as the recommended install.
- **Agents get the Rust binary too.** `--mcp` is Rust-only, the skill's
  installers install Rust releases, and the skill branches on `capabilities`.
  The `#agents` section therefore describes the Rust path and never implies
  the Python edition speaks MCP.
- **One page, four new sections.** No router, no framework, no new
  dependencies. The converter stays the first thing rendered.
- **No PyPI, no hosted service, no analytics.** Nothing here weakens the
  privacy guarantees in `AGENTS.md`.

## 2. Page structure

Current body: `.hero` → `.privacy-strip` → `.work` (options + converter) →
`.site-footer`, all inside `.main` (max width 880px).

New markup goes between the close of `.work` (`index.html:320`) and
`<footer>` (`index.html:322`), inside `.main`, so it inherits the column:

```
.hero              unchanged
.privacy-strip     unchanged
.section-nav       NEW   one quiet line: Run locally · Use with an agent · CLI reference
.work              unchanged  ← keep above the fold
#local             NEW   Run it locally
#agents            NEW   Use it from your agent
#editions          NEW   Which edition
#cli               NEW   CLI reference
.site-footer       extended with the same links plus llms.txt
```

`.section-nav` is a single row of `<a href="#local">` links under the privacy
strip: discoverable, keyboard reachable, and it does not compete with the drop
zone. It grows one link per slice, so no anchor ever points at a section that
does not exist yet.

Every section is `<section id="…" class="section" aria-labelledby="…-title">`
with an `<h2 id="…-title">`. All content is static HTML; nothing is built by
JavaScript, so adding these sections cannot cause layout shift.

## 3. Section content

### 3.1 `#local` — Rust first

Three tabs. Default tab from `navigator.userAgentData?.platform ??
navigator.platform`, never from a network probe.

| Tab | Command block |
| --- | --- |
| macOS / Linux (default) | `curl -fsSLO https://github.com/aditya-xq/PicToWebP/releases/download/rust-latest/install.sh` then `sh install.sh --json` |
| Windows | `irm https://github.com/aditya-xq/PicToWebP/releases/download/rust-latest/install.ps1 -OutFile install.ps1` then `.\install.ps1 -Json` |
| Docker | `docker build -t pictowebp .` then `docker run --rm -p 127.0.0.1:8000:8000 pictowebp` |

Each panel carries:

1. the command, one command per block, no `$` prompt inside the block;
2. the expected output underneath (compact, two or three lines);
3. a verify line: `pictowebp --info --json`;
4. one note: `install.sh --require-attestation` needs `gh` 2.49+.

A single footnote under the tabs, not a fourth tab:

> Building from source, or running the Python edition's local server? See
> `CONTRIBUTING.md`. The Python package is not published on PyPI, so
> `pip install pictowebp` does not exist yet.

The Python edition stays in the editions table as a column, not as an install
path. Docker is the supported way to run the web UI locally without a checkout
toolchain.

Three copy decisions that need to be right:

- **Capture the expected output from a released binary, do not hand-write it.**
  The local `src_rust/target` build is 0.3.0; published releases are 0.4.0 and
  the capability list differs (0.4.0 includes `mcp`). The plan is to install
  0.4.0 once and paste the real output.
- **Bind Docker to loopback.** `README.md:103` publishes `-p 8000:8000`, which
  exposes the server on every interface. Use `-p 127.0.0.1:8000:8000` on the
  page and fix the README to match; the privacy strip claims local-only.
- **Do not imply the Docker image bundles the prebuilt SPA.** It runs
  `npm run build:python` inside the build stage, so the image is correct, but
  the contributor footnote should still say that `pictowebp-web` from a
  checkout needs `web-ts/dist-python` built first — the 503 message is the
  only place that says it today.

### 3.2 `#agents` — skill install and MCP

```
npx skills add https://xqbuilds.com/pictowebp/
```

Use the canonical host, since that is what the validator enforces and what
`rel="canonical"` names. The Pages URL keeps working and stays linked from
`llms.txt`.

Below the command, three short blocks:

- **What the agent gets**: one `--json` object on stdout, exit codes, and a
  `--dry-run` it should try first above ~200 files. Link
  `[llms.txt]`, `[llms-full.txt]`, `[agent contract]`.
- **MCP**: `pictowebp --mcp` with the `info` and `convert` tools, marked
  **Rust 0.4.0+** explicitly, plus a JSON snippet for a stdio server config.
- **Manual install**: `npx skills add` is a convenience; the skill directory is
  also published at `/.well-known/agent-skills/pictowebp/` and can be dropped
  into any agent's skills folder.

### 3.3 `#editions` — three columns, capability-driven

| | Browser | Rust CLI | Python server |
| --- | --- | --- | --- |
| Install | none | signed binary | from source, contributors only |
| Lossless | no | yes | yes |
| Keep metadata | no | yes | yes |
| MCP | no | yes | no |
| Fastest on batches | — | yes | — |
| Needs a runtime | no | no | Python 3.11+ |

The row for the **currently running** edition is highlighted from `cap.kind`,
and the note under the table is swapped by capability:

- `cap.metadataControl === false` → "This edition cannot preserve metadata;
  canvas decoding drops it before the encoder runs."
- `cap.lossless === false` → "This edition has no lossless mode."

That reuses the existing capability model instead of restating it.

The Python column stays factual and is never presented as something to
install: the Docker tab is the supported way to run its local server UI, and
the footnote under `#local` points contributors at `CONTRIBUTING.md`.

### 3.4 `#cli` — flags and exit codes

A compact table of the flags that matter to a script author (`-q`, `-t`,
`--json`, `--out`, `--dry-run`, `--fail-on-error`, `--fail-on-empty`,
`--lossless`, `--keep-metadata`, `--report`, `--max-pixels`, `--no-progress`,
`--mcp`) and the exit-code table (`0 1 2 3 4 5 130`).

`docs/agent-contract.md` is normative; the page must not become a second
source of truth. See the guard in §5.

## 4. Implementation sketch

New modules, all small and side-effect free at import time:

| File | Responsibility | Rough size |
| --- | --- | --- |
| `web-ts/src/site/content.ts` | typed content: tabs, commands, edition rows, flags | 120 lines |
| `web-ts/src/site/tabs.ts` | `role="tablist"` wiring, arrow keys, roving tabindex | 60 lines |
| `web-ts/src/ui/copy.ts` | `copyText` + "Copied" state + clipboard fallback | 45 lines |
| `web-ts/src/site/init.ts` | mount sections: tabs, copy buttons, edition highlight | 70 lines |
| `web-ts/src/ui.css` | `.section`, `.section-nav`, `.codeblock`, `.tabs`, `.cmd-grid`, `.edition-grid` | +200 lines |

`main.ts` gains one call in `initUI()`: `initSiteSections(backend.capabilities)`.
No existing element IDs change.

Markup uses the same primitives as the app: `.card` for panels, `.btn`,
`.chips`/`.chip` shapes for tabs, `--font-mono` for commands, and the existing
`--radius-*`, `--brand-*` and `--glass-*` tokens. No new colours, no new fonts,
no external assets.

## 5. Drift control

The failure mode for a page like this is copy that stays true for six months
and then quietly lies. Two guards, both cheap:

1. **Flags are checked against the contract.** Extend
   `validate-agent-surfaces.mjs`: extract every `--flag` token from
   `dist/index.html` and fail if one is missing from
   `docs/agent-contract.md`. Adding a flag to the UI without documenting it
   breaks the build.
2. **Capability copy is generated, not asserted.** The edition table's
   highlight and the two notes under it are computed from
   `backend.capabilities` at runtime, so a capability flip in
   `backend/browser.ts` changes the page.

Accepted risk, called out so it is a choice and not an oversight: the install
commands and the `latest.json` asset names are hand-written strings. They are
stable URLs (`rust-latest`), and a wrong one fails loudly for the user, but
nothing in CI can click them.

## 6. Accessibility and CSP

- Tabs: `role="tablist"`, `role="tab"` with `aria-selected` and
  `aria-controls`, `role="tabpanel"` with `tabindex="0"`, arrow/Home/End keys,
  roving `tabindex`. Visible focus ring from `--focus-ring`.
- Copy buttons: real `<button>` with an accessible name that changes to
  "Copied", plus a toast through the existing `aria-live` container.
  `navigator.clipboard.writeText` only; if it is unavailable, select the text
  and say so rather than silently failing.
- Anchors from the footer get `scroll-margin-top` so the heading is not flush
  against the viewport edge, and `prefers-reduced-motion` keeps scroll
  behaviour instant.
- CSP is untouched. `connect-src 'none'` stays in the static build; clipboard
  and tabs are local APIs. No inline handlers, no `unsafe-inline` for scripts.

## 7. Tests

| Layer | Added coverage |
| --- | --- |
| vitest | platform → default tab; flag extraction helper; command selection for `cap.kind` |
| `e2e/smoke.spec.ts` | four sections present; tab switch changes the visible panel; copy button flips to "Copied"; anchors resolve |
| `e2e-python/smoke.spec.ts` | same, plus the "you are running the server edition" line and the python note under `#editions` |
| `validate-agent-surfaces.mjs` | every `--flag` in the page exists in `docs/agent-contract.md` |

Playwright needs `permissions: ['clipboard-read', 'clipboard-write']` for the
copy assertion; the config uses `Desktop Chrome`, so that is a one-line
addition to `playwright.config.ts` and the python config.

## 8. Slices

Each slice is independently shippable and leaves the page coherent.

| Slice | Contents | Why this order |
| --- | --- | --- |
| **A** | `#local` + `.section-nav` (with its `#local` link) + `.section`/`.codeblock` styles + copy buttons | Answers the question the page currently cannot answer; highest value per line |
| **B** | `#agents` + tab component + the `#agents` nav link | Makes the Phase 1 surface discoverable from the page |
| **C** | `#editions` + `#cli` + the `#cli` nav link + the flag guard | Supporting detail, most prone to drift, so it ships with its guard |
| **D** | footer links, anchors, `scroll-margin-top`, README fixes (Docker port, `build:python` note) | Polish and the two documentation corrections found while planning |

## 9. Acceptance criteria

- The converter is still the first interactive thing at 390px tall viewport and
  above; no new section appears before it.
- The `.section-nav` row is keyboard reachable, and every link resolves to a
  section that exists in the same build.
- A user on macOS, Windows, Linux or Docker can copy one block and end with a
  working `pictowebp --version` without leaving the page.
- `npx skills add https://xqbuilds.com/pictowebp/` appears once, verbatim, and
  matches what CI verifies.
- No new dependency, no external asset, no CSP relaxation, no network call.
- Both build profiles pass vitest, both Playwright suites and the agent-surface
  validator; Lighthouse `agentic-browsing` still reports no regressions.

## 10. Explicitly out of scope

- PyPI publishing, or any command that assumes a published Python package.
- A separate docs site, router, or static site generator.
- Client-side search, a theme toggle, or a language switcher.
- WebMCP tool registration (see `docs/web-revamp-research.md` §7).

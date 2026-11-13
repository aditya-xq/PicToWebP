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

Two tabs. Default tab from `navigator.userAgentData?.platform ??
navigator.platform`, never from a network probe.

| Tab | Command block |
| --- | --- |
| macOS / Linux (default) | `curl -fsSLO https://github.com/aditya-xq/PicToWebP/releases/download/rust-latest/install.sh` then `sh install.sh --json` |
| Windows | `irm https://github.com/aditya-xq/PicToWebP/releases/download/rust-latest/install.ps1 -OutFile install.ps1` then `.\install.ps1 -Json` |

A Docker tab was in the first cut and removed: it needs a checkout, so it is the
same audience as the from-source footnote, and the README already documents the
container path. It stays out of the page.

Each panel carries:

1. the command, one command per block, no `$` prompt inside the block;
2. the expected output underneath (compact, two or three lines);
3. a verify line: `pictowebp --info --json`;
4. one note: `install.sh --require-attestation` needs `gh` 2.49+.

A single footnote under the tabs, not a fourth tab:

> Building from source, or running the Python edition's local server? See
> `CONTRIBUTING.md`. The Python package is not published on PyPI, so
> `pip install pictowebp` does not exist yet.

The Python edition is not shown as an install path or as a card: the container
route and the from-source workflow live in the README and CONTRIBUTING.

Three copy decisions that need to be right:

- **Capture the expected output from a released binary, do not hand-write it.**
  The local `src_rust/target` build is 0.3.0; published releases are 0.4.0 and
  the capability list differs (0.4.0 includes `mcp`). The plan is to install
  0.4.0 once and paste the real output.
- **Bind Docker to loopback.** `README.md:103` published `-p 8000:8000`, which
  exposes the server on every interface. Fix the README to
  `-p 127.0.0.1:8000:8000`; the privacy strip claims local-only.
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

### 3.3 `#editions` — two cards, capability-driven

The content matrix below, rendered as two cards (browser and CLI) so the
current one can be highlighted and the list stays readable on mobile:

| | Browser | Rust CLI |
| --- | --- | --- |
| Install | none | signed binary |
| Lossless | no | yes |
| Keep metadata | no | yes |
| MCP | no | yes |
| Fastest on batches | — | yes |
| Needs a runtime | no | no |

The Python server edition is deliberately absent: it is a contributor path, and
the page is where a visitor decides how to use the tool. When the Python build
serves this page nothing matches `cap.kind`, so no card is highlighted.

The card for the **currently running** edition is highlighted from `cap.kind`,
and the note under the cards is swapped by capability:

- `cap.metadataControl === false` → "This edition cannot preserve metadata;
  canvas decoding drops it before the encoder runs."
- `cap.lossless === false` → "This edition has no lossless mode."

That reuses the existing capability model instead of restating it.

The footnote under `#local` is the only Python mention on the page, and it
points at `CONTRIBUTING.md`; the README documents the container route.

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
| `web-ts/src/site/platform.ts` | `defaultTab()` + tab ids; no duplicated commands | 25 lines |
| `web-ts/src/site/tabs.ts` | `role="tablist"` wiring, arrow keys, roving tabindex | 60 lines |
| `web-ts/src/ui/copy.ts` | `copyText` + "Copied" state + clipboard fallback | 45 lines |
| `web-ts/src/site/init.ts` | mount sections: tabs, copy buttons, edition highlight | 70 lines |
| `web-ts/src/ui.css` | `.section`, `.section-nav`, `.codeblock`, `.copy-btn`, `.edition-card`, `.footnote` | +200 lines |

`main.ts` gains one call in the `DOMContentLoaded` handler:
`initSiteSections()`. It is deliberately **not** inside `initUI()`: that only
runs after `backend.probe()` succeeds, and the install instructions have to work
in a browser where conversion cannot start. No existing element IDs change.

One small addition to the existing build plugin: `index.html` uses a `__BASE__`
token for links to published artifacts (`href="__BASE__llms.txt"`), because Vite
does not rewrite `<a href>` and the two profiles have different bases.
`transformIndexHtml` returns `{ html: html.replaceAll('__BASE__', base), tags }`
and the validator fails if the token survives into `dist`.

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
2. **Capability copy is generated, not asserted.** The edition card highlight
   and the two notes under it are computed from
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

## 8. Step-by-step

Four shippable slices plus a prerequisite step. Every step names its files and
the command that proves it is done. Nothing is committed until its slice's
verification line is green.

### Step 0 — capture the real 0.4.0 facts (blocking, ~10 min)

The page must not publish fabricated output. `rust-latest/latest.json` reports
`version: 0.4.0`, which is the release the tabs point at.

```bash
cd /tmp && curl -fsSLO https://github.com/aditya-xq/PicToWebP/releases/download/rust-latest/install.sh
sh install.sh --install-dir ./pw-capture --json   # capture this JSON
./pw-capture/pictowebp --info --json              # capture this JSON
./pw-capture/pictowebp --version
```

Record three strings for the panels in `index.html` later:

1. the `install.sh --json` object (trimmed to the fields worth showing:
   `action`, `version`, `path`, `verified`);
2. the `--info --json` object, formatted to fit ~78 columns but with byte-exact
   values;
3. `pictowebp --version` output.

Confirm `capabilities` contains `mcp` before the `#agents` MCP block goes live.

---

### Slice A — `#local` (ships alone)

**A1. Nav row** — `web-ts/index.html`, after `</div>` of `.privacy-strip`
(line 101), before `<div class="work">` (line 103):

```html
<nav class="section-nav" aria-label="On this page">
  <a href="#local">Run locally</a>
</nav>
```

**A2. Section markup** — `web-ts/index.html`, between the close of `.work`
(line 320) and `<footer>` (line 322):

```html
<section id="local" class="section" aria-labelledby="local-title">
  <h2 class="section-title" id="local-title">Run it locally</h2>
  <p class="section-lede">A single signed binary. No runtime, no admin rights,
     no PATH edits.</p>
  <div class="tabs" role="tablist" aria-label="Install method">
    <button class="tab" role="tab" id="local-tab-unix"
            aria-controls="local-panel-unix" aria-selected="true" tabindex="0">macOS / Linux</button>
    <button class="tab" role="tab" id="local-tab-windows"
            aria-controls="local-panel-windows" aria-selected="false" tabindex="-1">Windows</button>
  </div>
  <div class="tabpanel" role="tabpanel" id="local-panel-unix"
       aria-labelledby="local-tab-unix" tabindex="0"> … </div>
  <div class="tabpanel" role="tabpanel" id="local-panel-windows"
       aria-labelledby="local-tab-windows" tabindex="0" hidden> … </div>
  <p class="footnote">Building from source, or running the Python edition's
     local server? See
     <a href="https://github.com/aditya-xq/PicToWebP/blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a>.
     …</p>
</section>
```

Each panel repeats this shape, one `.codeblock` per command:

```html
<div class="codeblock">
  <div class="codeblock-head"><span>Install</span>
    <button class="copy-btn" type="button" data-copy="cmd-unix-install">Copy</button></div>
  <pre id="cmd-unix-install"><code>curl -fsSLO …/install.sh
sh install.sh --json</code></pre>
</div>
```

**A3. Platform default** — new `web-ts/src/site/platform.ts`. Only the values
JavaScript actually needs live here; the commands and expected output stay in
the static markup so there is no second source of truth:

```ts
export type InstallTab = 'unix' | 'windows'
export const INSTALL_TAB_IDS: readonly InstallTab[]
export function defaultTab(nav?: { userAgentData?: { platform?: string }; platform?: string }): InstallTab
```

`defaultTab` is pure and takes the navigator as an argument so vitest can call
it directly.

**A4. Tabs** — new `web-ts/src/site/tabs.ts`:

```ts
export function wireTabs(tablist: HTMLElement): { activate(id: string): void }
```

Click, `ArrowLeft`/`ArrowRight`/`Home`/`End`, `aria-selected`, `tabindex`
roving, panel `hidden` toggling, focus follows the selected tab.

**A5. Copy** — new `web-ts/src/ui/copy.ts`:

```ts
export function wireCopyButtons(root: ParentNode, notify: (message: string) => void): void
```

Resolves `data-copy` to the `<pre>` text, writes via
`navigator.clipboard.writeText`, sets the label to `Copied` for 2 s and calls
`notify`, which is the existing `showToast`. If the clipboard API is missing or
rejects, select the `<pre>` contents and toast "Press Ctrl+C to copy".

**A6. Mount** — new `web-ts/src/site/init.ts`:

```ts
export function initSiteSections(): void
```

Wires every `.tabs` under `.main`, every `.copy-btn`, and activates
`defaultTab()`.

Call it from the `DOMContentLoaded` handler in `main.ts`, **not** from
`initUI()`: `initUI()` only runs after `backend.probe()` succeeds, and the
install instructions must work on a browser where conversion cannot start.

**A7. Styles** — `web-ts/src/ui.css`, appended in the existing section order:

| Class | Notes |
| --- | --- |
| `.section` | `margin-top: 40px`, `scroll-margin-top: 24px` |
| `.section-title`, `.section-lede` | display font, `--text-1`, `--text-2` |
| `.section-nav` | flex row, small caps, `--text-3`, `--brand-300` on hover |
| `.codeblock`, `.codeblock-head`, `.codeblock pre` | `--surface-deep`, `--font-mono`, horizontal scroll, `--radius-m` |
| `.copy-btn` | reuses `.btn-ghost` metrics, 32px, `aria-live` handled by the toast |
| `.tabs .tab[aria-selected='true']` | existing `.tab` styling drives the rest; this adds the selected state |
| `.footnote` | `--text-3`, 13px |

No new tokens, no new fonts, no gradients.

**A8. Clipboard in Playwright** — add to `use` in `web-ts/playwright.config.ts`
and `web-ts/playwright.python.config.ts`:

```ts
permissions: ['clipboard-read', 'clipboard-write'],
```

**A9. Tests**

- `web-ts/src/site/platform.test.ts`: `defaultTab` maps `Win32`/`Windows` →
  `windows`, `macOS`/`Linux` → `unix`, absent navigator → `unix`.
- `web-ts/e2e/smoke.spec.ts`: `#local` renders two tabs; clicking Windows
  makes `local-panel-windows` visible and hides the unix panel; the copy button
  flips to `Copied` and `navigator.clipboard.readText()` equals the command;
  `.section-nav a[href="#local"]` updates `location.hash`.

**A10. Verify**

```bash
cd web-ts && npm run typecheck && npm run build && npm test && npm run test:e2e
cd web-ts && npm run build:python && npm run test:e2e:python
```

---

### Slice B — `#agents`

**B1. Section markup** — `index.html`, after `#local`: heading, the
`npx skills add https://xqbuilds.com/pictowebp/` block with a copy button, and
three cards — *What the agent gets*, *MCP (Rust 0.4.0+)*, *Manual install*.

**B2. Doc links.** The three links (`llms.txt`, `llms-full.txt`,
`agent/agent-contract.md`) need the build base, and `<a href>` is not rewritten
by Vite. Use a token and replace it in the existing plugin:

- markup: `<a href="__BASE__llms.txt">`
- `web-ts/build/agent-surfaces.ts`: `transformIndexHtml(html)` returns
  `{ html: html.replaceAll('__BASE__', base), tags: […] }`
- `validate-agent-surfaces.mjs`: fail if `dist/index.html` still contains
  `__BASE__`.

This keeps the links working in both profiles and lets the xqbuilds sync
rewrite them the same way it rewrites everything else.

**B3. Nav link** — append `<a href="#agents">Use with an agent</a>`.

**B4. Tests** — assert the command string appears exactly once and matches the
constant used in `#local`'s skill link; `GET llms.txt` and `llms-full.txt`
return 200 from the section's links.

---

### Slice C — `#editions` and `#cli`

**C1. Editions cards** — three `<article class="edition-card">` blocks rather
than a table: easier to highlight and to read on mobile. Each gets
`data-edition="browser|rust|python"`; `initSiteSections()` adds `.is-current`
and a *You are here* badge to the card matching `backend.capabilities.kind`,
and swaps the two capability notes described in §3.3.

**C2. CLI tables** — flags table and exit-code table, static markup in
`index.html`. The page is the single list; the validator reads the built HTML,
so nothing has to stay in sync by hand.

**C3. Flag guard** — in `validate-agent-surfaces.mjs`:

```js
const contract = readFileSync(path.join(repo, 'docs/agent-contract.md'), 'utf8')
const pageFlags = new Set([...html.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))
for (const flag of pageFlags) {
  check(contract.includes(flag), `index.html names ${flag}, which docs/agent-contract.md does not document`)
}
```

**C4. Nav link** — append `<a href="#cli">CLI reference</a>`.

**C5. Tests** — static profile: browser card is current, metadata note present.
Python profile (`e2e-python/smoke.spec.ts`): python card is current, note
absent, server-edition line present.

---

### Slice D — polish and the two documentation fixes

**D1. Footer** — replace the single row with the section links plus
`llms.txt`, GitHub and the existing colophon.

**D2. Anchors** — `scroll-margin-top` on `.section`; smooth scrolling only under
`@media (prefers-reduced-motion: no-preference)`.

**D3. `README.md`** — two corrections found while planning:

- line 103: `docker run --rm -p 127.0.0.1:8000:8000 pictowebp`, matching the
  privacy claim;
- the Python section must say `npm run build:python` is required before
  `pictowebp-web`, not just in the 503 message.

**D4. Contributor docs** — `CONTRIBUTING.md` and `AGENTS.md`: list
`src/site/`, the `__BASE__` token rule, and the flag guard, so the next person
extends the page instead of forking it.

**D5. Regression check** — `npx lighthouse https://aditya-xq.github.io/PicToWebP/
--only-categories=agentic-browsing,accessibility,performance
--chrome-flags="--headless"` and compare CLS and accessibility against the
pre-Phase-2 report in `docs/web-revamp-research.md`.

**D6. Final verify** — typecheck, both builds, both Playwright suites, vitest,
validator, then deploy and re-run the post-deploy URL check in
`deploy-web-ts.yml`.

---

### Definition of done per slice

A slice is done when: both build profiles pass, the agent-surface validator
passes, the new Playwright assertions are green in both configs, and the
deployed page shows the section with no console errors and no CLS.

## 9. Acceptance criteria

- The converter is still the first interactive thing at 390px tall viewport and
  above; no new section appears before it.
- The `.section-nav` row is keyboard reachable, and every link resolves to a
  section that exists in the same build.
- A user on macOS, Windows or Linux can copy one block and end with a
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

# PicToWebP

> Free, private bulk image-to-WebP converter that runs on your machine. No
> uploads, no tracking, EXIF and GPS stripped by default.

This is the markdown twin of the web app at
<https://aditya-xq.github.io/PicToWebP/>. The app converts images in the browser
with no install. This page describes the same tool for readers that would rather
not parse HTML.

## What it does

PicToWebP converts JPEG, PNG and WebP images to WebP, in bulk (a whole folder,
recursively) or one at a time. It never uploads anything: the browser edition
decodes and re-encodes in an `OffscreenCanvas` worker, and the CLI runs entirely
on the machine.

Default result: about 55-80% smaller files at the same dimensions, depending on
quality and input.

## Two editions, one behaviour

| Edition | Get it | Best for |
| --- | --- | --- |
| Browser | <https://xqbuilds.com/pictowebp/> | no install, drag a folder and convert |
| Rust CLI | signed binaries from the releases page, or a cargo build | fastest, no runtime, lossless, metadata control |

A Python edition also exists behind the same CLI contract, but it is not
published on PyPI and is not the supported install path; see
<https://github.com/aditya-xq/PicToWebP/blob/main/CONTRIBUTING.md>.

The web UI is one codebase driven by a backend capability model, so only the
controls an edition can honour are shown.

## Options

- **Quality** , 1 to 100, default 80. Presets: Web 60, Balanced 80, High 95,
  Max 100.
- **Lossless** , every pixel preserved, larger output. The Rust CLI only; the
  browser edition cannot.
- **Strip metadata** , removes EXIF and GPS by default. The browser edition
  cannot preserve metadata at all, so the toggle is hidden there.

## Behaviour worth relying on

- Output goes to a unique sibling folder, `<source>_webp_<timestamp>`; nothing
  is overwritten and only fully converted files appear.
- Same-stem collisions (`a.png` and `a.jpg` both becoming `a.webp`) are skipped
  and reported.
- Dot-prefixed directories are skipped during enumeration.
- Oversized inputs are downscaled to browser canvas limits instead of failing.
- A single-image run never overwrites an existing `.webp`.

## For agents and scripts

Use the CLI rather than the web page:

```bash
pictowebp --info --json
pictowebp ./images --json --dry-run
pictowebp ./images --json --out ./images-webp
```

One JSON object on stdout, human output on stderr. Exit codes: `0` success,
`1` internal error, `2` invalid arguments or path, `3` nothing converted,
`4` failures with `--fail-on-error`, `5` empty with `--fail-on-empty`,
`130` cancelled.

Install the skill into a coding agent with:

```bash
npx skills add https://aditya-xq.github.io/PicToWebP/
```

More detail:

- [Agent entry point](https://aditya-xq.github.io/PicToWebP/llms.txt)
- [Everything in one file](https://aditya-xq.github.io/PicToWebP/llms-full.txt)
- [Skill](https://aditya-xq.github.io/PicToWebP/agent/pictowebp/SKILL.md)
- [Agent contract](https://aditya-xq.github.io/PicToWebP/agent/agent-contract.md)

## Privacy

There are no network calls, no telemetry, no analytics, no cookies and no
external assets. The static build ships a content security policy with
`connect-src 'none'`, so the page cannot reach the network even if a dependency
tried to. The local server binds `127.0.0.1`. Nothing is persisted between
sessions.

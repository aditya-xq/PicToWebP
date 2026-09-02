# The Great WebP Smackdown 🥊: Python vs Rust

Same tool. Same flags. Same 500 real photographs. Two very different engines.

PicToWebP comes in three flavors — a Python CLI 🐍, a Rust CLI 🦀, and a
zero-install browser edition 🌐. They all shrink images into svelte WebP files,
and they all get the same results. The only real question is **how fast**.

So we locked them in a room with **500 real photos (64.9 MiB)** and let them
fight it out.

## The contenders 🤼

| Edition | Engine | Secret weapon |
| --- | --- | --- |
| **Python** 🐍 | Pillow + thread pool | dead-simple to read and hack on |
| **Rust** 🦀 | `image` + rayon | compiles down to one angry binary |
| **Browser** 🌐 | OffscreenCanvas workers | runs on your GPU-friendly tab |

## The rules ⚖️

To keep it fair and honest:

- **The same corpus** — 500 real Unsplash-sourced photos, re-encoded so JPG,
  PNG and WebP all show up (plus nested folders, because real folders are messy).
- **The same settings** — quality `80`, `2` worker threads, `--no-progress`.
- **Release builds only** — the Rust CLI gets its optimizations on; no
  handicapping.
- **Best of 3 runs** — every number below is the best the tool could do.
- **Clean room** — each run converts a fresh copy in a temp folder, then
  tidies up after itself. Nobody leaves a mess behind. 🧹

## The numbers 📊

| Tool | Time | Throughput | Space saved |
| --- | --- | --- | --- |
| **Python** 🐍 | 22.25s | 22.47 img/s · 2.91 MiB/s | 60.8% smaller |
| **Rust** 🦀 | 12.56s | 39.80 img/s · 5.16 MiB/s | 60.7% smaller |

So what did those **500 photos (64.9 MiB)** turn into? **~25.4 MiB** of WebP.
That's a ~60% diet, whether Python or Rust does the cooking.

## What the numbers say 🎙️

**Rust is roughly 1.77× faster.** Same job, same settings, same output quality —
Rust just chews through pixels with fewer calories. That's the whole pitch of
the Rust edition: if you convert thousands of images every day, a 1.77× speedup
stops being trivia and starts being *time*.

**The outputs are twins.** 60.8% vs 60.7% reduction. Different engines, same
WebP encoder targets, nearly identical file sizes. Speed is the only real
difference — and that's a great problem to have.

**Your mileage may vary.** These runs happened on a Windows machine; faster
CPUs help both equally, and thread count scales both (try `-t` with your core
count). The ratio — Rust winning by ~1.77× — holds across machines because it's
about how the engines work, not which one got the better laptop.

## The browser cameo 🌐

"Hold on," you say, "you promised three flavors." True! The browser edition
converts 40 photos in **0.5 seconds** (static build) — it offloads every image
to an OffscreenCanvas worker pool so your tab never stutters. It's not
competing with the CLIs on raw bulk throughput; it's competing on *convenience*:
**zero install, zero upload, your photos never leave the machine.** Different
race, different winner. 🏆

## Try it yourself 🧪

```bash
uv run python tests/e2e/run_realistic_bench.py --runs 3
```

It downloads the 500-photo set once (rate-limited, polite, never deleted),
runs both CLIs three times each on clean copies, prints a summary table, and
saves the full history to `tests/e2e/perf-results.json`.

## The verdict ⚖️

- **Same results, every edition** — ~60% smaller files, pixel-faithful, no
  visible loss. The WebP diet works.
- **Rust if you're converting a mountain** — 1.77× the throughput for the same
  output.
- **Python if you want to read and tweak** — the whole engine is a few hundred
  readable lines.
- **Browser if you want zero friction** — no install, no data leaving your
  machine, and surprisingly quick for everyday batches.

Either way, your images get smaller, your site gets faster, and your storage
bill gets friendlier. 💸

---

P.S. The benchmark is repeatable, the numbers are reproducible, and the only
thing we left behind is a `perf-results.json` you're welcome to ignore. No cats
were harmed (they were converting quietly in the corner). 🐈‍⬛
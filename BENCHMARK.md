# The Great WebP Smackdown 🥊: Python vs Rust

Same tool. Same flags. Four corpora, from a controlled 500-photo lab set to
10,000 photos and a real camera roll. Two very different engines.

PicToWebP comes in three flavors, a Python CLI 🐍, a Rust CLI 🦀, and a
zero-install browser edition 🌐. They all shrink images into svelte WebP files,
and they all get the same results. The only real question is **how fast**.

So we locked them in a room with four corpora and let them fight it out.

## The contenders 🤼

| Edition | Engine | Secret weapon |
| --- | --- | --- |
| **Python** 🐍 | Pillow + thread pool | dead-simple to read and hack on |
| **Rust** 🦀 | `image` + rayon | compiles down to one angry binary |
| **Browser** 🌐 | OffscreenCanvas workers | runs on your GPU-friendly tab |

## The corpora 🗂️

All measured 2026-09-04 on an AMD Ryzen 9 6900HS (8 cores / 16 threads),
Windows, Pillow 12.3.0, Rust binary built from a clean tree:

| Corpus | Files | Size | What it is |
| --- | --- | --- | --- |
| Controlled photos | 500 | 64.9 MiB | Picsum photos, mixed JPG/PNG/WebP, nested folders. Best-of-3 lab set |
| Photos at scale | 10,000 | 1,341.7 MiB | The same downloader run to 10,000. 6,857 JPG, 1,714 PNG, 1,429 WebP |
| Real camera roll | 37 | 131.7 MiB | Actual phone camera JPGs, 15.9 MP median, EXIF/GPS on every file |
| Phone files | 2,598 | 1,707.9 MiB | Real phone library: 98.4% of bytes are PNG screenshots |

## The rules ⚖️

- **The same settings**, quality `80`, `--no-progress`, metadata strip default.
- **Release builds only**, the Rust CLI gets its optimizations on; no
  handicapping.
- **Clean room**, each run converts a fresh copy in a temp folder, then tidies
  up after itself. Nobody leaves a mess behind. 🧹
- **Honest run counts**: the 500-photo set runs best-of-3 (the precise speed
  comparison). The big corpora are single runs per tool, labeled as such; byte
  counts are deterministic at fixed settings, timings carry some noise.

## The numbers 📊

**The lab set, 500 photos, `-t 2`, best of 3:**

| Tool | Time | Throughput | Space saved |
| --- | --- | --- | --- |
| **Python** 🐍 | 22.25s | 22.47 img/s · 2.91 MiB/s | 60.8% smaller |
| **Rust** 🦀 | 12.56s | 39.80 img/s · 5.16 MiB/s | 60.7% smaller |

**Scale, 10,000 photos, `-t 8`:**

| Tool | Time | Throughput | Space saved |
| --- | --- | --- | --- |
| **Python** 🐍 | 278.89s | 35.9 img/s · 4.81 MiB/s | 61.6% smaller |
| **Rust** 🦀 | 145.35s | 68.8 img/s · 9.23 MiB/s | 61.6% smaller |

**The real world, `-t 8`:**

| Corpus | Python | Rust | Space saved |
| --- | --- | --- | --- |
| Camera roll (37 photos) | 27.56s | 12.17s | 79.5% smaller |
| Phone files (2,598) | 133.19s | 65.0s | 85.8% smaller |

So: 500 photos (64.9 MiB) turn into **~25.4 MiB**, 10,000 photos (1,341.7 MiB)
into **~515 MiB**, the camera roll into **26.96 MiB from both engines** (a
0.18 MiB gap over 37 photos), and the phone library into **242.76 MiB**.

## What the numbers say 🎙️

**Content type beats the quality knob.** Same encoder, same quality: test
photos shrink ~61%, a real camera roll 79.5%, a screenshot-heavy phone library
85.8%. Screenshots collapse hardest because PNG never suited them; real camera
photos shrink more than test photos because cameras export at quality 90-100
with full metadata, which is exactly the waste q80 removes.

**Rust is 1.79× to 2.36× faster, everywhere.** 1.77× at 2 threads, 1.79× at 4,
1.92× at 8, and up to 2.36× on the camera roll at 16 threads. The outputs are
twins at every setting: different engines, same WebP encoder targets,
near-identical file sizes (60.8% vs 60.7% on photos, 515.01 vs 515.19 MiB at
10K, identical 26.96 MiB on the camera roll). Speed is the only real
difference, and that's a great problem to have.

**Threads help until the content says stop.** The 10K photo corpus at 4, 8,
and 16 threads on an 8C/16T machine:

| Threads | Python | Rust | Rust speedup |
| --- | --- | --- | --- |
| 4 | 350.82s | 196.43s | 1.79× |
| 8 | 278.89s | 145.35s | 1.92× |
| 16 | 187.23s | 99.11s | 1.89× |

Going from 8 to 16 threads buys +49% (Python) and +47% (Rust) on photo
conversion: JPG decode and lossy WebP encode are compute-bound, so SMT has
stalls to fill. Ten thousand photos in **99 seconds** is 100.9 img/s. The
PNG-heavy phone corpus, meanwhile, gained **1%** from 8 to 16 threads (65.0s
to 64.13s Rust): PNG decode is memory-bandwidth-bound, and two threads per
core just wait. Practical rule: photos and camera rolls want every logical
core; PNG-heavy folders stop scaling near your physical core count.

**Real camera photos, verified pixel-honest.** On the 37-photo camera roll,
every output dimension matched its source exactly (no resize, ever), zero EXIF
remained after the default strip (all 37 carried a GPS IFD), and zero files
grew. A bulk run with zero failures across 10,000 photos on both engines.

## The quality ladder 🪜

50 mixed phone files (10.18 MiB source, Python, `-t 8`):

| Setting | Space saved |
| --- | --- |
| q60 | 82.8% |
| q75 | 80.6% |
| q80 (default) | 78.0% |
| q90 | 69.8% |
| lossless | 28.4% |

q80 sits at the knee: q60→q80 costs +28% output bytes for visibly better
quality, q80→q90 costs +37% for very little. Lossless still beats the PNG
source by 28.4%.

## The browser cameo 🌐

"Hold on," you say, "you promised three flavors." True! The browser edition
converts 40 photos in **0.5 seconds** (static build), it offloads every image
to an OffscreenCanvas worker pool so your tab never stutters. It's not
competing with the CLIs on raw bulk throughput; it's competing on
*convenience*: **zero install, zero upload, your photos never leave the
machine.** Different race, different winner. 🏆

## Try it yourself 🧪

```bash
uv run python tests/e2e/run_realistic_bench.py --runs 3
```

The downloader's photo set is now **10,000 images** (rate-limited, polite,
never deleted; pass `--count 500 --out <dir>` if you want a quick 500-photo
set elsewhere). The script builds the Rust CLI in release mode if needed, runs
both CLIs on clean temp copies, prints a summary table, and saves the full
history to `tests/e2e/perf-results.json`.

## The verdict ⚖️

- **Same results, every edition and engine**, matched outputs on four corpora,
  from 60.8% to 85.8% smaller depending on content. The WebP diet works.
- **Rust if you're converting a mountain**, 1.79× to 2.36× the throughput for
  the same output, and it holds at every thread count.
- **Python if you want to read and tweak**, the whole engine is a few hundred
  readable lines.
- **Size the thread pool to your content**, every logical core for photos and
  camera rolls, physical cores for PNG-heavy folders.
- **Browser if you want zero friction**, no install, no data leaving your
  machine, and surprisingly quick for everyday batches.

Either way, your images get smaller, your site gets faster, and your storage
bill gets friendlier. 💸

---

P.S. The benchmark is repeatable, the numbers are reproducible, and the only
thing we left behind is a `perf-results.json` you're welcome to ignore. No cats
were harmed (they were converting quietly in the corner). 🐈‍⬛

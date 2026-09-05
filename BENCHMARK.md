# Python vs Rust: which is faster?

PicToWebP comes in three versions: a Python app, a Rust app, and a browser
version. They all use the same settings and produce the same picture files.
The only real difference is how quickly they work.

We measured both apps on the same computer, on the same photos, with the same
settings (quality 80, no extra info saved). We let the apps run a few times and
kept the best results. The computer was an AMD Ryzen 9 6900HS with 8 cores and
16 threads, running Windows.

## Test 1: 500 photos

A mixed set of 500 photos (about 65 megabytes) in nested folders.

| App | Time | Smaller? |
| --- | --- | --- |
| Python | 22.25s | 60.8% smaller |
| Rust | 12.56s | 60.7% smaller |

Rust is about 1.8× faster, and both apps shrink the files to almost exactly the
same size.

## Test 2: a phone camera roll

37 photos straight from a phone (about 132 megabytes), each with location
info attached.

| App | Time | Smaller? |
| --- | --- | --- |
| Python | 29.39s | 79.5% smaller |
| Rust | 11.92s | 79.5% smaller |

Rust is about 2.5× faster. Both produce exactly the same final size, keep the
picture dimensions the same, and remove the location info. No file ever ends up
bigger than it started.

## Test 3: quality settings

20 photos, using different quality levels (lower = smaller but slightly worse):

| Setting | Smaller? |
| --- | --- |
| Quality 60 | 67.5% smaller |
| Quality 75 | 61.7% smaller |
| Quality 80 (the default) | 54.7% smaller |
| Quality 90 | 35.1% smaller |
| No-loss ("lossless") | 146% *bigger* |

Quality 80 is a good everyday choice: quality 90 saves very little extra but
makes the files much bigger. And turning off compression entirely makes the
files *larger*, which is why the app doesn't do that by default.

## What this means for you

- **Rust is faster, with the same result.** 1.8× to 2.5× quicker, and the
  pictures come out the same size. Speed is the only real difference.
- **The pictures matter more than the app.** A camera roll shrinks a lot (79.5%)
  because phone photos carry a lot of extra detail that quality 80 safely
  removes. Either app gives the same compression.
- **All versions agree.** Different code, same result.

## Try it yourself

```bash
uv run python tests/e2e/run_realistic_bench.py --runs 3
```

This runs both apps on a set of photos, prints the results, and saves the full
history to `tests/e2e/perf-results.json`.

## Which should you pick?

- **Rust** if you have a lot of photos.
- **Python** if you want code that's easy to read and change.
- **Browser** if you want no install and your photos never leaving your machine.

Either way, your images get smaller.

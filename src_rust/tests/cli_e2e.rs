//! Live end-to-end tests: spawn the real compiled `pictowebp` binary against a
//! copy of the shared fixture corpus (`tests/e2e/fixtures`), exercising the
//! actual process boundary, exit codes, output-folder allocation and crash-safe
//! writes. Temp copies are removed after every test.
//!
//! Expected corpus behaviour (Rust discovers jpg/jpeg/png/webp only):
//!     * converted: a b c, nested/deep/leaf (4 webp)
//!     * failed:    broken.png (corrupt)
//!     * skipped:   dup.png + dup.jpg (same-stem collision -> ambiguous target)
//!     * ignored:   d.bmp e.tiff f.gif (unsupported), .hidden/ (dot-directory)

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

const FIXTURES_REL: &str = "../tests/e2e/fixtures";
const ERROR_REPORT_NAME: &str = "conversion-errors.txt";

static RUN: AtomicU32 = AtomicU32::new(0);

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURES_REL)
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Clone the corpus into a fresh OS-temp source dir; returns the source path.
fn copy_corpus() -> PathBuf {
    let root = env::temp_dir().join(format!(
        "pw-e2e-rust-{}-{}",
        std::process::id(),
        RUN.fetch_add(1, Ordering::SeqCst)
    ));
    let source = root.join("source");
    copy_dir(&fixture_root(), &source);
    source
}

/// Run the real binary against `source` with default flags.
fn run_cli(source: &Path) -> std::process::ExitStatus {
    Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(source)
        .args(["-q", "80", "-t", "2", "--no-progress"])
        .current_dir(source.parent().unwrap())
        .output()
        .expect("failed to spawn the pictowebp binary")
        .status
}

fn output_folder(source: &Path) -> PathBuf {
    let outputs: Vec<PathBuf> = fs::read_dir(source.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir() && p != source)
        .collect();
    assert_eq!(
        outputs.len(),
        1,
        "expected exactly one <source>_webp_<timestamp> output folder"
    );
    outputs.into_iter().next().unwrap()
}

fn converted_webp(output: &Path) -> Vec<String> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("webp") {
                out.push(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    let mut out = Vec::new();
    walk(output, output, &mut out);
    out.sort();
    out
}

fn cleanup(source: &Path) {
    fs::remove_dir_all(source.parent().unwrap()).ok();
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn real_images_dir() -> PathBuf {
    repo_root().join("tests").join("e2e").join("real_images")
}

fn real_image_count() -> usize {
    let dir = real_images_dir();
    if !dir.is_dir() {
        return 0;
    }
    let mut count = 0;
    for entry in walk_files(&dir) {
        let ext = entry.extension().and_then(|e| e.to_str()).unwrap_or("");
        if matches!(ext, "jpg" | "jpeg" | "png" | "webp") {
            count += 1;
        }
    }
    count
}

fn walk_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk_files(&path));
        } else {
            files.push(path);
        }
    }
    files
}

#[test]
fn realistic_dataset_converts_and_reports_performance() {
    const EXPECTED: usize = 500;
    if real_image_count() < EXPECTED {
        // On-demand, rate-limited download through the shared Python script.
        let status = Command::new("uv")
            .args([
                "run",
                "python",
                "tests/e2e/download_real_dataset.py",
                "--count",
                "500",
            ])
            .current_dir(repo_root())
            .status();
        if !status.is_ok_and(|s| s.success()) || real_image_count() < EXPECTED {
            eprintln!(
                "skipping: realistic dataset unavailable; run `uv run python tests/e2e/download_real_dataset.py`"
            );
            return;
        }
    }

    // Work on a copy so the original dataset is never touched or cleaned up.
    let root = env::temp_dir().join(format!(
        "pw-e2e-rust-real-{}-{}",
        std::process::id(),
        RUN.fetch_add(1, Ordering::SeqCst)
    ));
    let source = root.join("source");
    copy_dir(&real_images_dir(), &source);
    let n = real_image_count();

    let started = Instant::now();
    let status = run_cli(&source);
    let elapsed = started.elapsed();

    assert_eq!(status.code(), Some(0));
    let output = output_folder(&source);
    assert_eq!(
        converted_webp(&output).len(),
        n,
        "every realistic photo must convert"
    );
    assert!(
        !output.join(ERROR_REPORT_NAME).exists(),
        "no failures expected in the dataset"
    );

    let per_second = n as f64 / elapsed.as_secs_f64();
    let source_mib = walk_files(&source)
        .iter()
        .map(|p| p.metadata().unwrap().len() as f64 / (1024.0 * 1024.0))
        .sum::<f64>();
    println!(
        "[perf] rust-cli: {n} images in {:.2}s = {:.2} img/s ({:.2} MiB source)",
        elapsed.as_secs_f64(),
        per_second,
        source_mib
    );

    fs::remove_dir_all(&root).ok();
}

#[test]
fn converts_supported_formats_and_skips_the_rest() {
    let source = copy_corpus();
    let status = run_cli(&source);
    assert_eq!(status.code(), Some(0));

    let output = output_folder(&source);
    let expected = ["a.webp", "b.webp", "c.webp", "nested/deep/leaf.webp"];
    assert_eq!(converted_webp(&output), expected);

    // Crash-safe: the corrupt input must never produce output, and hidden
    // directories are skipped entirely.
    assert!(!output.join("broken.webp").exists());
    assert!(!output.join("dup.webp").exists());
    assert!(
        !converted_webp(&output)
            .iter()
            .any(|p| p.contains(".hidden"))
    );
    // Unsupported formats (bmp/tiff/gif) are never discovered.
    assert!(
        !converted_webp(&output)
            .iter()
            .any(|p| matches!(p.as_str(), "d.webp" | "e.webp" | "f.webp"))
    );

    cleanup(&source);
}

#[test]
fn same_stem_collision_skips_both_inputs() {
    let source = copy_corpus();
    assert_eq!(run_cli(&source).code(), Some(0));

    let output = output_folder(&source);
    // Ambiguous target: neither dup.png nor dup.jpg may claim dup.webp.
    assert!(!output.join("dup.webp").exists());

    let report = fs::read_to_string(output.join(ERROR_REPORT_NAME)).unwrap();
    assert!(report.contains("dup.png"));
    assert!(report.contains("dup.jpg"));
    assert!(report.contains("dup.webp"));

    cleanup(&source);
}

#[test]
fn failure_report_lists_corrupt_file() {
    let source = copy_corpus();
    assert_eq!(run_cli(&source).code(), Some(0));

    let report = fs::read_to_string(output_folder(&source).join(ERROR_REPORT_NAME)).unwrap();
    assert!(report.contains("broken.png"));

    cleanup(&source);
}

#[test]
fn hidden_directory_is_never_converted() {
    let source = copy_corpus();
    assert_eq!(run_cli(&source).code(), Some(0));
    assert!(
        !converted_webp(&output_folder(&source))
            .iter()
            .any(|p| p.contains(".hidden"))
    );
    cleanup(&source);
}

#[test]
fn all_broken_input_exits_3() {
    let root = env::temp_dir().join(format!(
        "pw-e2e-rust-broken-{}-{}",
        std::process::id(),
        RUN.fetch_add(1, Ordering::SeqCst)
    ));
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("broken.png"), b"not an image").unwrap();

    assert_eq!(run_cli(&source).code(), Some(3));

    fs::remove_dir_all(&root).ok();
}

#[test]
fn missing_path_exits_2() {
    let status = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(env::temp_dir().join("pw-e2e-rust-does-not-exist"))
        .args(["-q", "80", "-t", "2", "--no-progress"])
        .output()
        .unwrap()
        .status;
    assert_eq!(status.code(), Some(2));
}

#[test]
fn empty_and_no_image_folders_are_noops() {
    let root = env::temp_dir().join(format!(
        "pw-e2e-rust-noop-{}-{}",
        std::process::id(),
        RUN.fetch_add(1, Ordering::SeqCst)
    ));
    let empty = root.join("empty");
    let text_only = root.join("text-only");
    fs::create_dir_all(&empty).unwrap();
    fs::create_dir_all(&text_only).unwrap();
    fs::write(text_only.join("notes.txt"), b"hello").unwrap();

    for source in [&empty, &text_only] {
        assert_eq!(run_cli(source).code(), Some(0));
        // No output folder is created for a no-op run.
        assert!(
            !fs::read_dir(&root).unwrap().any(|e| e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with("_webp_"))
        );
    }

    fs::remove_dir_all(&root).ok();
}

#[test]
fn lossless_flag_converts() {
    let source = copy_corpus();
    let status = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(&source)
        .args(["--lossless", "-t", "2", "--no-progress"])
        .current_dir(source.parent().unwrap())
        .output()
        .unwrap()
        .status;
    assert_eq!(status.code(), Some(0));
    assert!(output_folder(&source).join("a.webp").exists());
    cleanup(&source);
}

#[test]
fn interactive_prompt_flow() {
    let source = copy_corpus();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .args(["--no-progress"])
        .current_dir(source.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let stdin = child.stdin.as_mut().unwrap();
        // directory, then quality/threads left empty for defaults.
        writeln!(stdin, "{}", source.display()).unwrap();
        writeln!(stdin).unwrap();
        writeln!(stdin).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert!(output_folder(&source).is_dir());
    cleanup(&source);
}

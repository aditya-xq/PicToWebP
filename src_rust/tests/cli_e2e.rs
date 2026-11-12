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
    // The dataset may hold many thousands of files; the live test caps the
    // copy to a deterministic subset so runtime stays flat as the set grows.
    const MAX_FILES: usize = 200;
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
    let real_dir = real_images_dir();
    let mut files = walk_files(&real_dir);
    files.sort();
    files.truncate(MAX_FILES);
    for file in &files {
        let relative = file.strip_prefix(&real_dir).unwrap();
        let target = source.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(file, &target).unwrap();
    }
    let n = files.len();

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

/// Generate the shared photo fixture (gradient JPG with Make + GPS EXIF) via
/// the deterministic Python helper, mirroring the Python suite's input.
fn make_photo_fixture(target: &Path) -> bool {
    Command::new("uv")
        .args([
            "run",
            "python",
            "tests/e2e/make_photo_fixture.py",
            &target.to_string_lossy(),
        ])
        .current_dir(repo_root())
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[test]
fn photo_fidelity_preserves_dimensions_and_never_grows() {
    let root = env::temp_dir().join(format!(
        "pw-e2e-rust-fidelity-{}-{}",
        std::process::id(),
        RUN.fetch_add(1, Ordering::SeqCst)
    ));
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();

    let mut originals: Vec<(PathBuf, u64, (u32, u32))> = Vec::new();
    for index in 0..5 {
        let path = source.join(format!("photo_{index}.jpg"));
        if !make_photo_fixture(&path) {
            eprintln!("skipping: could not generate the photo fixture (uv/python unavailable)");
            fs::remove_dir_all(&root).ok();
            return;
        }
        let dims = image::ImageReader::open(&path)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap();
        originals.push((path.clone(), fs::metadata(&path).unwrap().len(), dims));
    }

    assert_eq!(run_cli(&source).code(), Some(0));
    let output = output_folder(&source);

    for (path, original_len, original_dims) in &originals {
        let webp = output
            .join(path.file_name().unwrap())
            .with_extension("webp");
        assert!(webp.exists(), "{} must convert", path.display());
        let webp_len = fs::metadata(&webp).unwrap().len();
        assert!(
            webp_len <= *original_len,
            "{} must not grow ({} -> {} bytes)",
            path.display(),
            original_len,
            webp_len
        );
        let webp_dims = image::ImageReader::open(&webp)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap();
        assert_eq!(
            webp_dims,
            *original_dims,
            "{} must keep its dimensions",
            path.display()
        );
    }

    cleanup(&source);
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
        .args(["--no-progress", "--interactive"])
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

fn run_capture(source: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(source)
        .args(args)
        .current_dir(source.parent().unwrap())
        .stdin(Stdio::null())
        .output()
        .expect("failed to spawn the pictowebp binary")
}

fn json_stdout(output: &std::process::Output) -> serde_json::Value {
    let text = String::from_utf8(output.stdout.clone()).unwrap();
    assert_eq!(
        text.trim().lines().count(),
        1,
        "stdout must hold exactly one JSON object, got: {text:?}"
    );
    serde_json::from_str(text.trim()).expect("stdout is not valid JSON")
}

#[test]
fn json_result_is_one_parseable_object() {
    let source = copy_corpus();
    let output = run_capture(&source, &["--json"]);
    assert_eq!(output.status.code(), Some(0));

    let value = json_stdout(&output);
    assert_eq!(value["schema"], "pictowebp.result/v1");
    assert_eq!(value["tool"]["edition"], "rust");
    assert_eq!(value["counts"]["discovered"], 7);
    assert_eq!(value["counts"]["converted"], 4);
    assert_eq!(value["counts"]["failed"], 1);
    assert_eq!(value["counts"]["collisions"], 2);
    assert_eq!(value["failures"].as_array().unwrap().len(), 3);
    assert!(Path::new(value["output"].as_str().unwrap()).is_dir());
    cleanup(&source);
}

#[test]
fn json_run_never_prompts_when_stdin_is_closed() {
    // No -q / -t: a non-interactive run must use defaults instead of blocking.
    let source = copy_corpus();
    let output = run_capture(&source, &["--json"]);
    assert_eq!(output.status.code(), Some(0));
    assert!(!output.stderr.is_empty(), "human output belongs on stderr");
    cleanup(&source);
}

#[test]
fn info_json_reports_edition_and_capabilities() {
    let source = copy_corpus();
    let output = run_capture(&source, &["--info", "--json"]);
    assert_eq!(output.status.code(), Some(0));

    let value = json_stdout(&output);
    assert_eq!(value["schema"], "pictowebp.info/v1");
    assert_eq!(value["edition"], "rust");
    let capabilities = value["capabilities"].as_array().unwrap();
    assert!(capabilities.iter().any(|value| value == "json"));
    assert!(capabilities.iter().any(|value| value == "dry_run"));
    cleanup(&source);
}

#[test]
fn version_and_help_are_machine_clean() {
    let version = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&version.stdout).contains("(rust)"));

    let help = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&help.stdout).contains("Bulk Image to WebP Converter"));
}

#[test]
fn dry_run_writes_nothing() {
    let source = copy_corpus();
    let before = fs::read_dir(source.parent().unwrap()).unwrap().count();

    let output = run_capture(&source, &["--json", "--dry-run"]);
    assert_eq!(output.status.code(), Some(0));
    let value = json_stdout(&output);
    assert_eq!(value["dry_run"], true);
    assert!(value["output"].is_null());
    assert_eq!(
        fs::read_dir(source.parent().unwrap()).unwrap().count(),
        before
    );
    cleanup(&source);
}

#[test]
fn single_file_converts_and_refuses_to_overwrite() {
    let source = copy_corpus();
    let file = source.join("a.png");

    let first = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(&file)
        .args(["--json"])
        .current_dir(source.as_path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(first.status.code(), Some(0));
    assert!(source.join("a.webp").is_file());

    let second = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(&file)
        .args(["--json"])
        .current_dir(source.as_path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(3));
    let value = json_stdout(&second);
    assert_eq!(value["counts"]["failed"], 1);
    cleanup(&source);
}

#[test]
fn out_dir_receives_the_converted_files() {
    let source = copy_corpus();
    let destination = source.parent().unwrap().join("dest");

    let output = run_capture(&source, &["--json", "--out", destination.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(0));
    assert!(destination.join("a.webp").is_file());
    let value = json_stdout(&output);
    assert_eq!(value["output"], destination.display().to_string());
    cleanup(&source);
}

#[test]
fn fail_on_empty_exits_5_and_fail_on_error_exits_4() {
    let empty = env::temp_dir().join(format!("pw-e2e-empty-{}", std::process::id()));
    fs::create_dir_all(&empty).unwrap();
    let empty_output = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(&empty)
        .args(["--json", "--fail-on-empty"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(empty_output.status.code(), Some(5));

    let source = copy_corpus();
    let errors = run_capture(&source, &["--json", "--fail-on-error"]);
    assert_eq!(errors.status.code(), Some(4));
    cleanup(&source);
    fs::remove_dir_all(&empty).ok();
}

#[test]
fn single_file_with_a_bare_relative_name() {
    let source = copy_corpus();
    let output = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg("a.png")
        .args(["--json"])
        .current_dir(&source)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{:?}", output);
    assert!(source.join("a.webp").is_file());
    let value = json_stdout(&output);
    assert_eq!(value["counts"]["converted"], 1);
    cleanup(&source);
}

#[test]
fn dry_run_reports_existing_single_file_output_without_failing_the_plan() {
    let source = copy_corpus();
    let file = source.join("a.png");

    let first = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(&file)
        .args(["--json"])
        .current_dir(&source)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(first.status.code(), Some(0));
    assert!(source.join("a.webp").is_file());

    let plan = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(&file)
        .args(["--json", "--dry-run"])
        .current_dir(&source)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(plan.status.code(), Some(0));
    let value = json_stdout(&plan);
    assert_eq!(value["dry_run"], true);
    assert_eq!(value["counts"]["converted"], 0);
    assert_eq!(value["counts"]["failed"], 1);
    cleanup(&source);
}

#[test]
fn dry_run_of_a_fully_colliding_folder_exits_0() {
    let root = env::temp_dir().join(format!("pw-e2e-dry-collide-{}", std::process::id()));
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    fs::copy(fixture_root().join("dup.png"), source.join("dup.png")).unwrap();
    fs::copy(fixture_root().join("dup.jpg"), source.join("dup.jpg")).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(&source)
        .args(["--json", "--dry-run"])
        .current_dir(&root)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let value = json_stdout(&output);
    assert_eq!(value["counts"]["collisions"], 2);
    assert_eq!(value["counts"]["converted"], 0);

    fs::remove_dir_all(&root).ok();
}

#[test]
fn json_argument_errors_are_machine_readable() {
    let output = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .args(["--json", "-q", "0"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let value = json_stdout(&output);
    assert_eq!(value["schema"], "pictowebp.error/v1");
}

#[test]
fn report_outside_the_output_folder_requires_a_flag() {
    let source = copy_corpus();
    let outside = source.parent().unwrap().join("report.txt");

    let denied = run_capture(&source, &["--json", "--report", outside.to_str().unwrap()]);
    assert_eq!(denied.status.code(), Some(2));
    let value = json_stdout(&denied);
    assert_eq!(value["schema"], "pictowebp.error/v1");
    assert!(!outside.exists());
    let parent = source.parent().unwrap();
    let prefix = format!("{}_webp_", source.file_name().unwrap().to_string_lossy());
    let left_output = std::fs::read_dir(parent)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix));
    assert!(!left_output, "rejected run left an output folder behind");

    let allowed = run_capture(
        &source,
        &[
            "--json",
            "--report",
            outside.to_str().unwrap(),
            "--allow-report-outside",
        ],
    );
    assert_eq!(allowed.status.code(), Some(0));
    assert!(outside.is_file());
    cleanup(&source);
}

#[test]
fn pixel_limit_skips_oversized_images() {
    let source = copy_corpus();
    let output = Command::new(env!("CARGO_BIN_EXE_pictowebp"))
        .arg(&source)
        .args(["--json", "--no-progress"])
        .env("PICTOWEBP_MAX_PIXELS", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let value = json_stdout(&output);
    assert_eq!(value["counts"]["converted"], 0);
    let failures = value["failures"].as_array().unwrap();
    assert!(
        failures
            .iter()
            .any(|failure| failure["category"] == "Image too large")
    );
    cleanup(&source);
}

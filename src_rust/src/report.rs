//! Machine-readable output for agent and CI use.

use std::path::Path;

use serde::Serialize;

use crate::convert::{ConvertResult, FileError};
use crate::settings::Settings;
use crate::style;
use crate::ui;

pub const RESULT_SCHEMA: &str = "pictowebp.result/v1";
pub const INFO_SCHEMA: &str = "pictowebp.info/v1";
pub const ERROR_SCHEMA: &str = "pictowebp.error/v1";

/// Cap on the number of failures embedded in a JSON result. Large batches keep
/// the full list in the conversion-errors report instead of flooding a caller's
/// context window.
pub const MAX_JSON_FAILURES: usize = 100;

/// Features an agent can rely on. Skills branch on this list instead of
/// comparing version numbers, so older releases degrade gracefully.
pub const CAPABILITIES: [&str; 12] = [
    "json",
    "info",
    "non_interactive",
    "interactive",
    "dry_run",
    "out_dir",
    "single_file",
    "fail_on_error",
    "fail_on_empty",
    "lossless",
    "keep_metadata",
    "mcp",
];

#[derive(Serialize)]
struct Tool {
    name: &'static str,
    edition: &'static str,
    version: &'static str,
    target: String,
}

#[derive(Serialize)]
struct Counts {
    discovered: usize,
    converted: u64,
    failed: usize,
    collisions: usize,
}

#[derive(Serialize)]
struct Bytes {
    source: u64,
    output: u64,
    saved: u64,
    reduction_percent: f64,
}

#[derive(Serialize)]
struct SettingsView<'a> {
    quality: u8,
    lossless: bool,
    threads: usize,
    max_pixels: u64,
    metadata: &'a str,
}

#[derive(Serialize)]
struct Failure<'a> {
    path: String,
    category: &'a str,
    message: &'a str,
}

#[derive(Serialize)]
struct ResultBody<'a> {
    schema: &'a str,
    ok: bool,
    tool: Tool,
    source: String,
    output: Option<String>,
    dry_run: bool,
    cancelled: bool,
    settings: SettingsView<'a>,
    counts: Counts,
    bytes: Bytes,
    duration_ms: u64,
    failures: Vec<Failure<'a>>,
    failures_truncated: bool,
    report: Option<String>,
}

fn target() -> String {
    format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
}

fn tool() -> Tool {
    Tool {
        name: "pictowebp",
        edition: "rust",
        version: env!("CARGO_PKG_VERSION"),
        target: target(),
    }
}

/// Build the `pictowebp.result/v1` object for one run.
#[allow(clippy::too_many_arguments)]
pub fn result_json(
    settings: &Settings,
    result: &ConvertResult,
    output_folder: Option<&Path>,
    discovered: usize,
    elapsed_ms: u64,
    cancelled: bool,
    report_path: Option<&Path>,
) -> String {
    let summary = &result.summary;
    let failures_total = result.file_errors.len();
    let failures: Vec<Failure<'_>> = result
        .file_errors
        .iter()
        .take(MAX_JSON_FAILURES)
        .map(failure_view)
        .collect();

    let body = ResultBody {
        schema: RESULT_SCHEMA,
        ok: !cancelled && summary.failed_files == 0 && summary.collision_files == 0,
        tool: tool(),
        source: settings.source.display().to_string(),
        output: display_output(output_folder),
        dry_run: settings.dry_run,
        cancelled,
        settings: SettingsView {
            quality: settings.quality,
            lossless: settings.lossless,
            threads: settings.threads.get(),
            max_pixels: settings.max_pixels,
            metadata: if settings.strip_metadata {
                "strip"
            } else {
                "keep"
            },
        },
        counts: Counts {
            discovered,
            converted: summary.converted_files,
            failed: summary.failed_files,
            collisions: summary.collision_files,
        },
        bytes: Bytes {
            source: summary.original_bytes,
            output: summary.converted_bytes,
            saved: summary.bytes_saved(),
            reduction_percent: round2(summary.reduction_percent()),
        },
        duration_ms: elapsed_ms,
        failures,
        failures_truncated: failures_total > MAX_JSON_FAILURES,
        report: report_path.map(|path| path.display().to_string()),
    };

    serde_json::to_string(&body).expect("result JSON is always serializable")
}

fn failure_view(error: &FileError) -> Failure<'_> {
    Failure {
        path: absolute_display(&error.path),
        category: error.category,
        message: &error.message,
    }
}

/// Report failure paths as absolute so callers can join them without knowing
/// the working directory the conversion ran in.
fn absolute_display(path: &Path) -> String {
    std::path::absolute(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

/// Render a destination folder as an absolute, prefix-free string. An empty
/// path (a single file in the current directory) resolves to the cwd.
fn display_output(path: Option<&Path>) -> Option<String> {
    let path = path?;
    let base = if path.as_os_str().is_empty() {
        Path::new(".")
    } else {
        path
    };
    let resolved = std::fs::canonicalize(base)
        .or_else(|_| std::path::absolute(base))
        .unwrap_or_else(|_| base.to_path_buf());
    let text = resolved.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        // Network shares canonicalize to ``\\?\UNC\server\share``; restore the
        // normal ``\\server\share`` spelling for machine consumers.
        return Some(format!(r"\\{rest}"));
    }
    Some(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[derive(Serialize)]
struct InfoBody<'a> {
    schema: &'a str,
    name: &'a str,
    edition: &'a str,
    version: &'a str,
    target: String,
    exe: Option<String>,
    capabilities: &'a [&'a str],
}

/// Build the `pictowebp.info/v1` object. Never performs a network call.
pub fn info_json() -> String {
    let body = InfoBody {
        schema: INFO_SCHEMA,
        name: "pictowebp",
        edition: "rust",
        version: env!("CARGO_PKG_VERSION"),
        target: target(),
        exe: std::env::current_exe()
            .ok()
            .map(|path| path.display().to_string()),
        capabilities: &CAPABILITIES,
    };
    serde_json::to_string(&body).expect("info JSON is always serializable")
}

/// Print the human-readable equivalent of `--info`.
pub fn print_info_human() {
    ui::emit_line("");
    ui::emit_line(format!("  PicToWebP {} (rust)", env!("CARGO_PKG_VERSION")));
    ui::emit_line("  Edition:      rust");
    ui::emit_line(format!("  Platform:     {}", target()));
    ui::emit_line(format!(
        "  Executable:   {}",
        style::sanitize(
            &std::env::current_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| "unknown".to_string())
        )
    ));
    ui::emit_line(format!("  Capabilities: {}", CAPABILITIES.join(", ")));
    ui::emit_line("");
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    schema: &'a str,
    error: String,
}

pub fn error_json(message: &str) -> String {
    let body = ErrorBody {
        schema: ERROR_SCHEMA,
        error: message.to_string(),
    };
    serde_json::to_string(&body).expect("error JSON is always serializable")
}

/// Emit a JSON object on stdout, one line, with a trailing newline.
pub fn emit_json(payload: &str) {
    println!("{payload}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::Summary;

    #[test]
    fn capabilities_are_stable_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for capability in CAPABILITIES {
            assert!(
                seen.insert(capability),
                "duplicate capability: {capability}"
            );
        }
        assert!(CAPABILITIES.contains(&"json"));
    }

    #[test]
    fn result_json_reports_counts_and_truncates_failures() {
        let folder = std::env::temp_dir().join("pictowebp-report-test");
        let settings = Settings {
            source: folder.clone(),
            source_root: folder,
            single_file: false,
            quality: 80,
            threads: std::num::NonZeroUsize::new(2).unwrap(),
            max_pixels: crate::settings::DEFAULT_MAX_PIXELS,
            lossless: false,
            strip_metadata: true,
            no_progress: true,
            report_path: None,
            allow_report_outside: false,
            output_dir: None,
            dry_run: false,
            json: true,
            fail_on_error: false,
            fail_on_empty: false,
        };
        let errors: Vec<FileError> = (0..(MAX_JSON_FAILURES + 5))
            .map(|index| FileError {
                path: std::path::PathBuf::from(format!("bad-{index}.png")),
                category: "Corrupt or mislabeled image",
                message: "invalid data".to_string(),
            })
            .collect();
        let result = ConvertResult {
            summary: Summary {
                converted_files: 1,
                failed_files: errors.len(),
                collision_files: 2,
                original_bytes: 100,
                converted_bytes: 40,
            },
            file_errors: errors,
        };

        let json = result_json(
            &settings,
            &result,
            Some(Path::new("out")),
            10,
            1234,
            false,
            None,
        );
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(value["schema"], RESULT_SCHEMA);
        assert_eq!(value["counts"]["failed"], MAX_JSON_FAILURES + 5);
        assert_eq!(value["counts"]["collisions"], 2);
        assert_eq!(
            value["failures"].as_array().unwrap().len(),
            MAX_JSON_FAILURES
        );
        assert_eq!(value["failures_truncated"], true);
        assert_eq!(value["ok"], false);
        assert_eq!(value["bytes"]["reduction_percent"], 60.0);
    }

    #[test]
    fn info_json_lists_capabilities_without_network_access() {
        let value: serde_json::Value = serde_json::from_str(&info_json()).unwrap();
        assert_eq!(value["schema"], INFO_SCHEMA);
        assert_eq!(value["edition"], "rust");
        assert!(value["capabilities"].as_array().unwrap().len() >= 5);
    }
}

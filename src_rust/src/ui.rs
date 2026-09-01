//! Terminal UI helpers: banner, progress bar, prompts and the final report.

use std::io;
use std::path::Path;
use std::time::Duration;

use indicatif::{ProgressBar, ProgressStyle};

use crate::convert::{ConvertResult, FileError, Summary};
use crate::settings::Settings;
use crate::style::{self, BOLD_CYAN, CYAN, DIM, GREEN, LINE, RED, YELLOW, paint, truncate_reason};

const BYTES_PER_KIB: f64 = 1024.0;
const BYTES_PER_MIB: f64 = 1024.0 * 1024.0;
const BYTES_PER_GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Format a count with thousands separators (e.g. `2590` -> `2,590`).
pub fn format_count(value: usize) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// Format a byte count for humans (e.g. `1.7 GB`, `512 B`).
pub fn format_bytes(bytes: u64) -> String {
    let bytes = bytes as f64;
    if bytes >= BYTES_PER_GIB {
        format!("{:.2} GB", bytes / BYTES_PER_GIB)
    } else if bytes >= BYTES_PER_MIB {
        format!("{:.1} MB", bytes / BYTES_PER_MIB)
    } else if bytes >= BYTES_PER_KIB {
        format!("{:.1} KB", bytes / BYTES_PER_KIB)
    } else {
        format!("{bytes} B")
    }
}

/// Format an elapsed duration for humans (e.g. `46.1s`, `3m 05s`).
pub fn format_duration(seconds: f64) -> String {
    if seconds < 60.0 {
        return format!("{seconds:.1}s");
    }
    let total = seconds as u64;
    format!("{}m {:02}s", total / 60, total % 60)
}

/// Print a welcome banner.
pub fn print_banner() {
    println!();
    println!("  {}", paint("PicToWebP", BOLD_CYAN));
    println!("  {}", paint("Bulk Image to WebP Converter", DIM));
    println!();
}

/// Print how many images were discovered and their combined size.
pub fn print_found(count: usize, total_bytes: u64) {
    println!(
        "  {} {} images ({})",
        paint("Found", DIM),
        format_count(count),
        format_bytes(total_bytes)
    );
    println!();
}

/// Open a folder in the OS file explorer (best-effort, errors ignored).
pub fn open_folder(path: &Path) {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();
    let _ = result;
}

/// Ask whether to open the output folder, and do it when confirmed.
///
/// Only prompts when stdin and stdout are interactive terminals, so piped and
/// scripted runs are never interrupted.
pub fn maybe_open_output_folder(output_folder: &Path, converted: u64) {
    use std::io::IsTerminal;
    if converted == 0 || !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return;
    }
    print!("  Open the output folder? [Y/n] ");
    use std::io::Write as _;
    let _ = std::io::stdout().flush();
    let answer = read_trimmed_line().unwrap_or_else(|| "n".to_string());
    if answer.is_empty() || answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes") {
        open_folder(output_folder);
    }
}

/// Build a styled progress bar for `total` items.
pub fn progress_bar(total: usize) -> ProgressBar {
    let style = ProgressStyle::with_template(
        "  {spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({per_sec}) ({eta})",
    )
    .expect("progress bar template should be valid")
    .progress_chars("##-");

    let bar = ProgressBar::new(total as u64);
    bar.set_style(style);
    bar.enable_steady_tick(Duration::from_millis(100));
    bar
}

/// Read one trimmed line from stdin.
///
/// Returns ``None`` when stdin is closed (EOF), letting callers abort instead
/// of looping forever.
pub fn read_trimmed_line() -> Option<String> {
    let mut buffer = String::new();
    match io::stdin().read_line(&mut buffer) {
        Ok(0) => None,
        Ok(_) => Some(buffer.trim().to_string()),
        Err(_) => None,
    }
}

fn section(title: &str, style: &str) {
    println!("  {}", paint(LINE, DIM));
    println!("   {}", paint(title, style));
    println!("  {}", paint(LINE, DIM));
}

/// Print an aligned `Label: value` pair (mirrors the Python CLI's `field`).
fn field(label: &str, value: impl std::fmt::Display) {
    println!("  {} {value}", paint(label, CYAN));
}

/// Print the settings banner before conversion starts.
pub fn print_settings(source: &Path, output: &Path, threads: usize, settings: &Settings) {
    println!();
    section("Configuration", BOLD_CYAN);
    println!();
    field("Source:", style::display_path(source));
    field("Output:", style::display_path(output));
    field(
        "Quality:",
        format!(
            "{}{}",
            settings.quality,
            if settings.lossless { " (lossless)" } else { "" }
        ),
    );
    field("Threads:", threads);
    field(
        "Mode:",
        if settings.lossless {
            "lossless"
        } else {
            "lossy"
        },
    );
    field(
        "Metadata:",
        if settings.strip_metadata {
            "strip"
        } else {
            "keep"
        },
    );
    if settings.resize_width.is_some() || settings.resize_height.is_some() {
        let size = format!(
            "{}x{}",
            settings
                .resize_width
                .map(|w| w.to_string())
                .unwrap_or_else(|| "auto".to_string()),
            settings
                .resize_height
                .map(|h| h.to_string())
                .unwrap_or_else(|| "auto".to_string())
        );
        field("Resize:", format!("max {size}"));
    } else {
        field("Resize:", "original");
    }
    println!();
}

/// Print the post-conversion summary, including failure groups.
pub fn print_summary(
    summary: &Summary,
    output_folder: &Path,
    elapsed: Duration,
    file_errors: &[FileError],
    error_report: Option<&Path>,
) {
    println!();

    if summary.failed_files == 0 {
        section("✓ Conversion Complete", GREEN);
    } else {
        section("Conversion Complete (with errors)", YELLOW);
    }

    println!();
    field("Output folder:", style::display_path(output_folder));
    field(
        "Images converted:",
        format!(
            "{}/{}",
            format_count(summary.converted_files as usize),
            format_count((summary.converted_files + summary.failed_files as u64) as usize)
        ),
    );
    field(
        "Memory reduced:",
        format!(
            "{} ({:.2}%)",
            format_bytes(summary.bytes_saved()),
            summary.reduction_percent()
        ),
    );
    field("Time taken:", format_duration(elapsed.as_secs_f64()));

    print_failure_groups(file_errors, error_report);

    println!("  {}", paint(LINE, DIM));
    println!();
}

/// Print the cancellation message after a Ctrl+C interrupt.
pub fn print_cancelled(result: &ConvertResult, output_folder: &Path, elapsed: Duration) {
    println!();
    section("Cancelled by user", YELLOW);
    println!();
    field("Output folder:", style::display_path(output_folder));
    field(
        "Files completed:",
        format!(
            "{}/{}",
            format_count(result.summary.converted_files as usize),
            format_count(
                (result.summary.converted_files + result.summary.failed_files as u64) as usize
            )
        ),
    );
    field(
        "Time before cancel:",
        format_duration(elapsed.as_secs_f64()),
    );

    if !result.file_errors.is_empty() {
        print_failure_groups(&result.file_errors, None);
    }

    println!("  {}", paint(LINE, DIM));
    println!();
}

fn print_failure_groups(file_errors: &[FileError], error_report: Option<&Path>) {
    if file_errors.is_empty() {
        return;
    }

    println!();
    section(&format!("Files Not Converted ({})", file_errors.len()), RED);
    println!();

    // Group errors by (category, message), preserving first-seen order.
    let mut groups: Vec<((&str, &str), Vec<&Path>)> = Vec::new();
    let mut index: std::collections::HashMap<(&str, &str), usize> =
        std::collections::HashMap::new();

    for error in file_errors {
        let key = (error.category, error.message.as_str());
        if let Some(&idx) = index.get(&key) {
            groups[idx].1.push(&error.path);
        } else {
            index.insert(key, groups.len());
            groups.push((key, vec![&error.path]));
        }
    }

    // Sort largest groups first.
    groups.sort_by_key(|group| std::cmp::Reverse(group.1.len()));

    for ((category, reason), paths) in &groups {
        let display_reason = truncate_reason(reason);
        if paths.len() == 1 {
            println!(
                "  {} {display_reason}",
                paint(format!("{category}:"), YELLOW)
            );
            println!("    {}", paint(style::display_path(paths[0]), DIM));
        } else {
            println!(
                "  {} {display_reason} ({})",
                paint(format!("{category}:"), YELLOW),
                format_count(paths.len())
            );
            for path in paths {
                println!("    {}", paint(style::display_path(path), DIM));
            }
        }
        println!();
    }

    if let Some(report) = error_report {
        field("Error report:", style::display_path(report));
    }
}

/// Print the "no files found" message.
pub fn print_no_files_found(source: &Path) {
    println!();
    section("No convertible images found", YELLOW);
    println!();
    field("Source:", style::display_path(source));
    println!();
}

/// Print a free-space warning when the destination is low.
pub fn print_disk_warning(disk: &crate::style::DiskSpace) {
    if let Some(free) = disk.free_bytes {
        if disk.low {
            let free_mib = free as f64 / (1024.0 * 1024.0);
            println!(
                "  {} only {:.0} MiB free in {} — conversion may run out of space.",
                paint("Warning:", YELLOW),
                free_mib,
                style::display_path(&disk.path)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_count_groups_thousands() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1_000), "1,000");
        assert_eq!(format_count(2_590), "2,590");
        assert_eq!(format_count(1_234_567), "1,234,567");
    }

    #[test]
    fn format_bytes_uses_readable_units() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.00 GB");
    }

    #[test]
    fn format_duration_stays_compact() {
        assert_eq!(format_duration(7.24), "7.2s");
        assert_eq!(format_duration(46.11), "46.1s");
        assert_eq!(format_duration(65.0), "1m 05s");
        assert_eq!(format_duration(186.0), "3m 06s");
    }

    #[test]
    fn maybe_open_output_folder_never_prompts_when_not_a_tty() {
        // Tests run with non-TTY stdio; the helper must return without
        // reading stdin (which would block or consume test input).
        maybe_open_output_folder(Path::new("."), 5);
    }
}

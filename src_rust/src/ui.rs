//! Terminal UI helpers: banner, progress bar, prompts and the final report.

use std::io;
use std::path::Path;
use std::time::Duration;

use indicatif::{ProgressBar, ProgressStyle};

use crate::convert::{ConvertResult, FileError, Summary};
use crate::settings::Settings;
use crate::style::{self, BOLD_CYAN, CYAN, DIM, GREEN, LINE, RED, YELLOW, paint, truncate_reason};

const BYTES_PER_MIB: f64 = 1024.0 * 1024.0;

/// Print a welcome banner.
pub fn print_banner() {
    println!();
    println!("  {}", paint("PicToWebP", BOLD_CYAN));
    println!("  {}", paint("Bulk Image to WebP Converter", DIM));
    println!();
}

/// Build a styled progress bar for `total` items.
pub fn progress_bar(total: usize) -> ProgressBar {
    let style = ProgressStyle::with_template(
        "  {spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({eta})",
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

/// Print the settings banner before conversion starts.
pub fn print_settings(
    source: &Path,
    output: &Path,
    quality: u8,
    threads: usize,
    settings: &Settings,
) {
    println!();
    section("Configuration", BOLD_CYAN);
    println!();
    println!(
        "  {} {}",
        paint("Source: ", CYAN),
        style::display_path(source)
    );
    println!(
        "  {} {}",
        paint("Output: ", CYAN),
        style::display_path(output)
    );
    println!(
        "  {} {}{}",
        paint("Quality:", CYAN),
        quality,
        if settings.lossless { " (lossless)" } else { "" }
    );
    println!("  {} {threads}", paint("Threads:", CYAN));
    println!(
        "  {} {}",
        paint("Mode:", CYAN),
        if settings.lossless {
            "lossless"
        } else {
            "lossy"
        }
    );
    println!(
        "  {} {}",
        paint("Metadata:", CYAN),
        if settings.strip_metadata {
            "strip"
        } else {
            "keep"
        }
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
        println!("  {} max {size}", paint("Resize:", CYAN));
    } else {
        println!("  {} original", paint("Resize:", CYAN));
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
    println!(
        "  {} {}",
        paint("Output folder:", CYAN),
        style::display_path(output_folder)
    );
    println!(
        "  {} {}/{}",
        paint("Images converted:", CYAN),
        summary.converted_files,
        summary.converted_files + summary.failed_files as u64,
    );
    println!(
        "  {} {:.2} MB ({:.2}%)",
        paint("Memory reduced:", CYAN),
        summary.bytes_saved() as f64 / BYTES_PER_MIB,
        summary.reduction_percent()
    );
    println!(
        "  {} {:.2} seconds",
        paint("Time taken:", CYAN),
        elapsed.as_secs_f64()
    );

    print_failure_groups(file_errors, error_report);

    println!("  {}", paint(LINE, DIM));
    println!();
}

/// Print the cancellation message after a Ctrl+C interrupt.
pub fn print_cancelled(result: &ConvertResult, output_folder: &Path, elapsed: Duration) {
    println!();
    section("Cancelled by user", YELLOW);
    println!();
    println!(
        "  {} {}",
        paint("Output folder:", CYAN),
        style::display_path(output_folder)
    );
    println!(
        "  {} {}/{}",
        paint("Files completed:", CYAN),
        result.summary.converted_files,
        result.summary.converted_files + result.summary.failed_files as u64,
    );
    println!(
        "  {} {:.2} seconds",
        paint("Time before cancel:", CYAN),
        elapsed.as_secs_f64()
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
        match index.get(&key) {
            Some(&idx) => groups[idx].1.push(&error.path),
            None => {
                index.insert(key, groups.len());
                groups.push((key, vec![&error.path]));
            }
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
                paths.len()
            );
            for path in paths {
                println!("    {}", paint(style::display_path(path), DIM));
            }
        }
        println!();
    }

    if let Some(report) = error_report {
        println!(
            "  {} {}",
            paint("Error report:", CYAN),
            style::display_path(report)
        );
    }
}

/// Print the "no files found" message.
pub fn print_no_files_found(source: &Path) {
    println!();
    section("No convertible images found", YELLOW);
    println!();
    println!(
        "  {} {}",
        paint("Source:", CYAN),
        style::display_path(source)
    );
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

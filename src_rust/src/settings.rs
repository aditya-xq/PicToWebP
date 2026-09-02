//! Interactive collection of conversion settings.

use std::num::NonZeroUsize;
use std::path::PathBuf;

use clap::Parser;

use crate::ui;

pub const DEFAULT_QUALITY: u8 = 80;

/// Fully resolved user settings for one run.
#[derive(Debug, Clone)]
pub struct Settings {
    pub source_folder: PathBuf,
    pub quality: u8,
    pub threads: NonZeroUsize,
    pub lossless: bool,
    pub strip_metadata: bool,
    pub no_progress: bool,
    pub report_path: Option<PathBuf>,
}

/// Command-line arguments. Omitted values are prompted for interactively.
#[derive(Debug, Clone, Parser)]
#[command(about = "Bulk-convert images to WebP.", version)]
pub struct Cli {
    /// Folder containing the images to convert
    pub path: Option<PathBuf>,

    /// WebP quality, from 1 to 100
    #[arg(short, long, value_parser = parse_quality)]
    pub quality: Option<u8>,

    /// Number of conversion workers
    #[arg(short, long, value_parser = parse_threads)]
    pub threads: Option<NonZeroUsize>,

    /// Use lossless WebP encoding (overrides --quality)
    #[arg(long)]
    pub lossless: bool,

    /// Keep EXIF/metadata in the converted image (default: strip)
    #[arg(long)]
    pub keep_metadata: bool,

    /// Do not render the conversion progress bar
    #[arg(long)]
    pub no_progress: bool,

    /// Write the conversion-errors report to a custom path
    #[arg(long)]
    pub report: Option<PathBuf>,
}

/// Resolve command-line arguments, prompting for values that were omitted.
///
/// A CLI-provided path is assumed to have been validated by the caller.
pub fn resolve(cli: Cli) -> anyhow::Result<Settings> {
    let source_folder = match cli.path {
        Some(path) => path,
        None => prompt_input(
            "Enter the path to the source folder: ",
            |raw| Some(normalize_path_input(raw)),
            |path| path.is_dir(),
            "Invalid directory path. Please enter a valid path.",
            None,
        ),
    };
    // In lossless mode quality is ignored, so never prompt for it.
    let quality = if cli.lossless {
        DEFAULT_QUALITY
    } else {
        cli.quality.unwrap_or_else(|| {
            prompt_input(
                &format!("Enter the quality 1-100 (default {DEFAULT_QUALITY}): "),
                |raw| raw.parse::<u8>().ok(),
                |quality| (1..=100).contains(quality),
                "Invalid input. Please enter a number between 1 and 100.",
                Some(DEFAULT_QUALITY),
            )
        })
    };
    let threads = cli.threads.unwrap_or_else(|| {
        NonZeroUsize::new(prompt_input(
            &format!(
                "Enter the number of threads (default {}): ",
                default_thread_count()
            ),
            |raw| raw.parse::<usize>().ok(),
            |threads| *threads > 0,
            "Invalid input. Please enter a positive number.",
            Some(default_thread_count()),
        ))
        .expect("validated thread count is non-zero")
    });

    Ok(Settings {
        // Keep the original (non-canonicalized) path for display. Canonicalizing
        // adds the Windows ``\\?\`` verbatim prefix which is unfriendly in
        // a terminal. The conversion code only relies on relative paths under
        // this folder, so the original spelling is sufficient.
        source_folder: source_folder.clone(),
        quality,
        threads,
        lossless: cli.lossless,
        strip_metadata: !cli.keep_metadata,
        no_progress: cli.no_progress,
        report_path: cli.report,
    })
}

fn parse_quality(raw: &str) -> Result<u8, String> {
    let quality = raw
        .parse::<u8>()
        .map_err(|_| "must be a number".to_string())?;
    if (1..=100).contains(&quality) {
        Ok(quality)
    } else {
        Err("must be between 1 and 100".to_string())
    }
}

fn parse_threads(raw: &str) -> Result<NonZeroUsize, String> {
    raw.parse::<NonZeroUsize>()
        .map_err(|_| "must be a positive number".to_string())
}

fn default_thread_count() -> usize {
    std::thread::available_parallelism()
        .map(NonZeroUsize::get)
        .unwrap_or(16)
}

/// Clean up a hand-typed or pasted path: trim whitespace, strip surrounding
/// quotes (Explorer's "Copy as path" adds them) and expand a leading `~`
/// to the user's home directory.
fn normalize_path_input(raw: &str) -> PathBuf {
    let trimmed = raw.trim().trim_matches('"').trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let rest = trimmed
                .trim_start_matches('~')
                .trim_start_matches(['/', '\\']);
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(trimmed)
}

/// Generic read-parse-validate prompt loop with optional default on empty input.
///
/// Aborts the process when stdin closes, so a piped/redirected run can never
/// spin forever.
fn prompt_input<T: Clone>(
    prompt_text: &str,
    parse: impl Fn(&str) -> Option<T>,
    is_valid: impl Fn(&T) -> bool,
    invalid_message: &str,
    default: Option<T>,
) -> T {
    use std::io::Write as _;

    loop {
        // Print inline (no newline) so the user's answer appears on the same line.
        print!("{prompt_text}");
        let _ = std::io::stdout().flush();

        let trimmed = match ui::read_trimmed_line() {
            Some(line) => line,
            None => {
                eprintln!("\nInput stream closed. Exiting.");
                std::process::exit(1);
            }
        };

        if trimmed.is_empty() {
            match &default {
                Some(value) => return value.clone(),
                None => continue,
            }
        }

        match parse(&trimmed) {
            Some(value) if is_valid(&value) => return value,
            _ => eprintln!("{invalid_message}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_command_line_values() {
        assert_eq!(parse_quality("80"), Ok(80));
        assert!(parse_quality("0").is_err());
        assert!(parse_threads("0").is_err());
    }

    #[test]
    fn normalizes_pasted_paths() {
        assert_eq!(
            normalize_path_input(r#"  "C:\My Photos"  "#),
            PathBuf::from(r"C:\My Photos")
        );
        assert_eq!(
            normalize_path_input("/tmp/photos"),
            PathBuf::from("/tmp/photos")
        );
    }

    #[test]
    fn expands_tilde_to_home_directory() {
        let home = std::env::temp_dir().join("pictowebp-home-test");
        let previous = (std::env::var_os("USERPROFILE"), std::env::var_os("HOME"));
        // SAFETY: single-threaded test; restoring the originals afterwards.
        unsafe {
            std::env::set_var("USERPROFILE", &home);
            std::env::remove_var("HOME");
        }

        assert_eq!(normalize_path_input("~"), home);
        assert_eq!(normalize_path_input("~/pictures"), home.join("pictures"));

        // SAFETY: restoring the values captured above.
        unsafe {
            match previous.0 {
                Some(value) => std::env::set_var("USERPROFILE", value),
                None => std::env::remove_var("USERPROFILE"),
            }
            match previous.1 {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
        }
        std::fs::remove_dir(&home).ok();
    }
}

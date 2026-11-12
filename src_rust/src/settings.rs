//! Command-line settings and interactive prompts.

use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};

use clap::Parser;

use crate::ui;

pub const DEFAULT_QUALITY: u8 = 80;
pub const MAX_THREADS: usize = 256;

/// Default cap on decoded pixels per image. Covers current 100 MP medium
/// format (101–102 M), 150 MP digital backs, 200 MP phones, and 400 MP
/// multi-shot composites. Override with `--max-pixels` or
/// `PICTOWEBP_MAX_PIXELS`.
pub const DEFAULT_MAX_PIXELS: u64 = 500_000_000;

/// Images above this size are converted one at a time so a few giant files
/// cannot multiply peak memory by the worker count.
pub const LARGE_IMAGE_PIXELS: u64 = 100_000_000;

/// Fully resolved user settings for one run.
#[derive(Debug, Clone)]
pub struct Settings {
    /// The path the user supplied (a folder or a single image).
    pub source: PathBuf,
    /// Folder used as the root when mirroring outputs. For a single file this
    /// is the file's parent folder.
    pub source_root: PathBuf,
    pub single_file: bool,
    pub quality: u8,
    pub threads: NonZeroUsize,
    pub max_pixels: u64,
    pub lossless: bool,
    pub strip_metadata: bool,
    pub no_progress: bool,
    pub report_path: Option<PathBuf>,
    pub allow_report_outside: bool,
    pub output_dir: Option<PathBuf>,
    pub dry_run: bool,
    pub json: bool,
    pub fail_on_error: bool,
    pub fail_on_empty: bool,
}

/// Command-line arguments. Omitted values are prompted for in interactive runs
/// and fall back to defaults when the CLI is driven by a script or an agent.
#[derive(Debug, Clone, Parser)]
#[command(about = "Bulk-convert images to WebP.", version = concat!(env!("CARGO_PKG_VERSION"), " (rust)"))]
pub struct Cli {
    /// Folder (or single image) to convert
    pub path: Option<PathBuf>,

    /// WebP quality, from 1 to 100
    #[arg(short, long, value_parser = parse_quality)]
    pub quality: Option<u8>,

    /// Number of conversion workers
    #[arg(short, long, value_parser = parse_threads)]
    pub threads: Option<NonZeroUsize>,

    /// Maximum decoded pixels per image (default: 500000000)
    #[arg(long, value_parser = parse_max_pixels)]
    pub max_pixels: Option<u64>,

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

    /// Allow --report to write outside the output folder
    #[arg(long)]
    pub allow_report_outside: bool,

    /// Write one machine-readable JSON object to stdout
    #[arg(long)]
    pub json: bool,

    /// Print tool metadata and exit (no conversion)
    #[arg(long)]
    pub info: bool,

    /// Never prompt; use defaults for omitted options
    #[arg(long)]
    pub yes: bool,

    /// Force the interactive prompt flow even when stdio is not a terminal
    #[arg(long)]
    pub interactive: bool,

    /// Write output into this folder (created when missing, must be empty)
    #[arg(long)]
    pub out: Option<PathBuf>,

    /// Discover and validate only; write nothing
    #[arg(long)]
    pub dry_run: bool,

    /// Exit non-zero when any file fails or collides
    #[arg(long)]
    pub fail_on_error: bool,

    /// Exit non-zero when no convertible images are found
    #[arg(long)]
    pub fail_on_empty: bool,
}

/// True when both stdin and stdout are attached to a terminal.
pub fn stdio_is_interactive() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Resolve command-line arguments, prompting only for genuinely interactive
/// runs. Scripted and agent-driven runs always use defaults instead of blocking
/// on input.
pub fn resolve(cli: Cli, interactive: bool) -> anyhow::Result<Settings> {
    let source = match cli.path {
        Some(path) => path,
        None if interactive => prompt_input(
            "Enter the path to the source folder: ",
            |raw| Some(normalize_path_input(raw)),
            |path| path.exists(),
            "Invalid path. Please enter a valid folder or image path.",
            None,
        ),
        None => anyhow::bail!(
            "No source path provided. Pass a folder or a single image path, or run without arguments in a terminal."
        ),
    };

    if !source.exists() {
        anyhow::bail!("Source path does not exist: {}", source.display());
    }
    let single_file = source.is_file();
    if !single_file && !source.is_dir() {
        anyhow::bail!(
            "Source path is neither a folder nor a file: {}",
            source.display()
        );
    }
    let source_root = if single_file {
        // A bare relative name (`pictowebp photo.png`) has an empty parent;
        // keeping it empty lets `strip_prefix` resolve the file name.
        source.parent().map(Path::to_path_buf).unwrap_or_default()
    } else {
        source.clone()
    };

    // In lossless mode quality is ignored, so never prompt for it.
    let quality = if cli.lossless {
        DEFAULT_QUALITY
    } else if let Some(quality) = cli.quality {
        quality
    } else if interactive {
        prompt_input(
            &format!("Enter the quality 1-100 (default {DEFAULT_QUALITY}): "),
            |raw| raw.parse::<u8>().ok(),
            |quality| (1..=100).contains(quality),
            "Invalid input. Please enter a number between 1 and 100.",
            Some(DEFAULT_QUALITY),
        )
    } else {
        DEFAULT_QUALITY
    };

    let threads = match cli.threads {
        Some(threads) => threads,
        None if interactive => NonZeroUsize::new(prompt_input(
            &format!(
                "Enter the number of threads (default {}): ",
                default_thread_count()
            ),
            |raw| raw.parse::<usize>().ok(),
            |threads| (1..=MAX_THREADS).contains(threads),
            &format!("Invalid input. Please enter a number between 1 and {MAX_THREADS}."),
            Some(default_thread_count()),
        ))
        .expect("validated thread count is non-zero"),
        None => NonZeroUsize::new(default_thread_count()).unwrap_or(NonZeroUsize::MIN),
    };

    let max_pixels = cli
        .max_pixels
        .or_else(|| {
            std::env::var("PICTOWEBP_MAX_PIXELS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
        })
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_PIXELS);

    Ok(Settings {
        // Keep the original (non-canonicalized) path for display. Canonicalizing
        // adds the Windows ``\\?\`` verbatim prefix which is unfriendly in a
        // terminal. The conversion code only relies on relative paths under
        // this folder, so the original spelling is sufficient.
        source: source.clone(),
        source_root,
        single_file,
        quality,
        threads,
        max_pixels,
        lossless: cli.lossless,
        strip_metadata: !cli.keep_metadata,
        // A JSON run must keep stdout clean, so the progress bar is always off.
        no_progress: cli.no_progress || cli.json,
        report_path: cli.report,
        allow_report_outside: cli.allow_report_outside,
        output_dir: cli.out,
        dry_run: cli.dry_run,
        json: cli.json,
        fail_on_error: cli.fail_on_error,
        fail_on_empty: cli.fail_on_empty,
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
    let threads = raw
        .parse::<NonZeroUsize>()
        .map_err(|_| "must be a positive number".to_string())?;
    if threads.get() > MAX_THREADS {
        return Err(format!("must be {MAX_THREADS} or fewer"));
    }
    Ok(threads)
}

fn parse_max_pixels(raw: &str) -> Result<u64, String> {
    match raw.parse::<u64>() {
        Ok(value) if value > 0 => Ok(value),
        _ => Err("must be a positive number of pixels".to_string()),
    }
}

fn default_thread_count() -> usize {
    std::thread::available_parallelism()
        .map(NonZeroUsize::get)
        .unwrap_or(16)
        .min(MAX_THREADS)
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
        ui::prompt_text(prompt_text);
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

    fn base_cli(path: PathBuf) -> Cli {
        Cli {
            path: Some(path),
            quality: None,
            threads: None,
            max_pixels: None,
            lossless: false,
            keep_metadata: false,
            no_progress: false,
            report: None,
            allow_report_outside: false,
            json: false,
            info: false,
            yes: false,
            interactive: false,
            out: None,
            dry_run: false,
            fail_on_error: false,
            fail_on_empty: false,
        }
    }

    #[test]
    fn validates_command_line_values() {
        assert_eq!(parse_quality("80"), Ok(80));
        assert!(parse_quality("0").is_err());
        assert!(parse_threads("0").is_err());
        assert!(parse_threads("256").is_ok());
        assert!(parse_threads("257").is_err());
        assert!(default_thread_count() <= MAX_THREADS);
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

    #[test]
    fn non_interactive_runs_use_defaults_instead_of_prompting() {
        let folder =
            std::env::temp_dir().join(format!("pictowebp-settings-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();

        let settings = resolve(base_cli(folder.clone()), false).unwrap();

        assert_eq!(settings.quality, DEFAULT_QUALITY);
        assert!(settings.threads.get() >= 1);
        assert!(settings.max_pixels > 0);
        assert!(!settings.single_file);
        assert!(!settings.dry_run);

        std::fs::remove_dir_all(&folder).ok();
    }

    #[test]
    fn single_file_input_uses_its_parent_as_root() {
        let folder = std::env::temp_dir().join(format!("pictowebp-single-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("photo.png");
        std::fs::write(&file, b"x").unwrap();

        let settings = resolve(base_cli(file.clone()), false).unwrap();

        assert!(settings.single_file);
        assert_eq!(settings.source_root, folder);
        assert_eq!(settings.source, file);

        std::fs::remove_dir_all(&folder).ok();
    }

    #[test]
    fn help_advertises_the_agent_contract() {
        use clap::CommandFactory;

        let help = Cli::command().render_help().to_string();
        for flag in [
            "--json",
            "--info",
            "--yes",
            "--interactive",
            "--out",
            "--dry-run",
            "--fail-on-error",
            "--fail-on-empty",
            "--allow-report-outside",
            "--max-pixels",
        ] {
            assert!(help.contains(flag), "{flag} missing from --help");
        }
    }
}

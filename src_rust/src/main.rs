//! PicToWebP: blazingly fast bulk image-to-WebP conversion.

mod convert;
mod discovery;
mod paths;
mod settings;
mod style;
mod ui;

use std::process::ExitCode;
use std::time::Instant;

use clap::Parser;

use convert::CANCEL_REQUESTED;
use style::paint;

const TOTAL_FAILURE_EXIT_CODE: u8 = 3;
const INVALID_ARGUMENT_EXIT_CODE: u8 = 2;
const CANCELLED_EXIT_CODE: u8 = 130;

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> anyhow::Result<ExitCode> {
    ui::print_banner();

    // Reset the cancellation flag at the start of every run.
    CANCEL_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);

    let cli = settings::Cli::parse();
    if let Some(path) = &cli.path {
        if !path.is_dir() {
            eprintln!(
                "Error: Source folder does not exist or is not a directory: {}",
                path.display()
            );
            return Ok(ExitCode::from(INVALID_ARGUMENT_EXIT_CODE));
        }
    }
    let settings = settings::resolve(cli)?;
    let image_files = discovery::discover_images(&settings.source_folder);

    if image_files.is_empty() {
        ui::print_no_files_found(&settings.source_folder);
        return Ok(ExitCode::SUCCESS);
    }

    let output_folder = paths::resolve_output_folder(&settings.source_folder)
        .map_err(|error| anyhow::anyhow!("Failed to create output folder: {error:#}"))?;

    ui::print_settings(
        &settings.source_folder,
        &output_folder,
        settings.quality,
        settings.threads.get().min(image_files.len()),
        &settings,
    );

    let disk = style::check_disk_space(&output_folder);
    ui::print_disk_warning(&disk);

    install_ctrlc_handler();

    let progress_bar = if settings.no_progress {
        indicatif::ProgressBar::hidden()
    } else {
        ui::progress_bar(image_files.len())
    };
    let started = Instant::now();
    let result = convert::convert_all(&image_files, &settings, &output_folder, progress_bar);
    let error_report = match convert::write_error_report(
        &output_folder,
        &result.file_errors,
        settings.report_path.as_deref(),
    ) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("Could not write conversion error report: {error}");
            None
        }
    };

    let exit_code = if CANCEL_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
        ui::print_cancelled(&result, &output_folder, started.elapsed());
        ExitCode::from(CANCELLED_EXIT_CODE)
    } else {
        ui::print_summary(
            &result.summary,
            &output_folder,
            started.elapsed(),
            &result.file_errors,
            error_report.as_deref(),
        );
        // Exit non-zero only when nothing converted (a hard failure) or the
        // user interrupted. Partial failures are reported in the summary and
        // the error report, but do not warrant a non-zero exit code.
        if result.summary.converted_files == 0 && result.summary.failed_files > 0 {
            ExitCode::from(TOTAL_FAILURE_EXIT_CODE)
        } else {
            ExitCode::SUCCESS
        }
    };
    Ok(exit_code)
}

fn install_ctrlc_handler() {
    if let Err(error) = ctrlc::set_handler(|| {
        use std::sync::atomic::Ordering;
        if CANCEL_REQUESTED.swap(true, Ordering::SeqCst) {
            // Second Ctrl+C: terminate immediately so users are not stuck.
            std::process::exit(i32::from(CANCELLED_EXIT_CODE));
        }
        eprintln!(
            "\n{}",
            paint(
                "Cancellation requested. Finishing in-flight conversions and stopping.",
                style::YELLOW
            )
        );
    }) {
        eprintln!("Could not install Ctrl+C handler: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_use_documented_values() {
        assert_eq!(TOTAL_FAILURE_EXIT_CODE, 3);
        assert_eq!(INVALID_ARGUMENT_EXIT_CODE, 2);
        assert_eq!(CANCELLED_EXIT_CODE, 130);
    }
}
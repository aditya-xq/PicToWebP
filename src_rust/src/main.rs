//! PicToWebP: blazingly fast bulk image-to-WebP conversion.

mod convert;
mod discovery;
mod paths;
mod report;
mod settings;
mod style;
mod ui;

use std::ffi::OsStr;
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

use clap::Parser;

use convert::CANCEL_REQUESTED;
use style::paint;

const TOTAL_FAILURE_EXIT_CODE: u8 = 3;
const INVALID_ARGUMENT_EXIT_CODE: u8 = 2;
const FAILURES_EXIT_CODE: u8 = 4;
const EMPTY_EXIT_CODE: u8 = 5;
const CANCELLED_EXIT_CODE: u8 = 130;

fn main() -> ExitCode {
    // Parse before printing the banner so `--help` and `--version` stay
    // machine-clean and a bad argument never produces decorative output first.
    let json_requested =
        std::env::args_os().any(|argument| argument.as_os_str() == std::ffi::OsStr::new("--json"));
    let cli = match settings::Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            // clap still owns help/version/usage output; only mirror real
            // argument errors as a JSON object when --json was requested.
            if error.use_stderr() && json_requested {
                report::emit_json(&report::error_json(error.to_string().trim()));
            }
            error.exit();
        }
    };
    let json = cli.json;
    match run(cli) {
        Ok(code) => code,
        Err(error) => {
            if json {
                report::emit_json(&report::error_json(&format!("{error:#}")));
            }
            eprintln!("Error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: settings::Cli) -> anyhow::Result<ExitCode> {
    // Reset the cancellation flag at the start of every run.
    CANCEL_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);
    ui::set_json_mode(cli.json);

    if cli.info {
        if cli.json {
            report::emit_json(&report::info_json());
        } else {
            report::print_info_human();
        }
        return Ok(ExitCode::SUCCESS);
    }

    let allow_prompt = !cli.yes;
    let interactive =
        !cli.yes && !cli.json && (cli.interactive || settings::stdio_is_interactive());
    let settings = match settings::resolve(cli, interactive) {
        Ok(settings) => settings,
        Err(error) => {
            if ui::is_json_mode() {
                report::emit_json(&report::error_json(&format!("{error:#}")));
            }
            eprintln!("Error: {error:#}");
            return Ok(ExitCode::from(INVALID_ARGUMENT_EXIT_CODE));
        }
    };

    if !settings.json {
        ui::print_banner();
    }

    let files = if settings.single_file {
        vec![settings.source.clone()]
    } else {
        discovery::discover_images(&settings.source)
    };
    let discovered = files.len();

    let total_source_bytes: u64 = files
        .iter()
        .filter_map(|file| std::fs::metadata(file).ok())
        .map(|metadata| metadata.len())
        .sum();

    if files.is_empty() {
        ui::print_no_files_found(&settings.source);
        if settings.json {
            emit_result(
                &settings,
                &convert::ConvertResult::default(),
                None,
                0,
                0,
                false,
                None,
            );
        }
        return Ok(if settings.fail_on_empty {
            ExitCode::from(EMPTY_EXIT_CODE)
        } else {
            ExitCode::SUCCESS
        });
    }

    ui::print_found(discovered, total_source_bytes);

    let output_existed = settings
        .output_dir
        .as_deref()
        .map(Path::exists)
        .unwrap_or(false);
    let output_folder = match paths::resolve_output_folder(
        &settings.source_root,
        settings.output_dir.as_deref(),
        settings.single_file,
        settings.dry_run,
    ) {
        Ok(folder) => folder,
        Err(error) => {
            if ui::is_json_mode() {
                report::emit_json(&report::error_json(&format!("{error:#}")));
            }
            eprintln!("Error: {error:#}");
            return Ok(ExitCode::from(INVALID_ARGUMENT_EXIT_CODE));
        }
    };

    // Keep reports next to the converted files by default; an explicit flag is
    // required to write somewhere else.
    if !settings.dry_run {
        if let (Some(report_path), Some(folder)) =
            (settings.report_path.as_deref(), output_folder.as_deref())
        {
            if !settings.allow_report_outside && !paths::is_inside(report_path, folder) {
                let message = "--report must be inside the output folder; \
                               pass --allow-report-outside to write elsewhere";
                if ui::is_json_mode() {
                    report::emit_json(&report::error_json(message));
                }
                eprintln!("Error: {message}");
                // A rejected run must not leave an empty output folder behind.
                if !output_existed && (settings.output_dir.is_some() || !settings.single_file) {
                    if let Some(folder) = output_folder.as_deref() {
                        let _ = std::fs::remove_dir(folder);
                    }
                }
                return Ok(ExitCode::from(INVALID_ARGUMENT_EXIT_CODE));
            }
        }
    }

    ui::print_settings(
        &settings.source,
        output_folder.as_deref(),
        settings.threads.get().min(files.len()),
        &settings,
    );

    if !settings.dry_run {
        if let Some(output_folder) = &output_folder {
            let disk = style::check_disk_space(output_folder);
            ui::print_disk_warning(&disk);
        }
        install_ctrlc_handler();
    }

    // A single file is never overwritten: an existing `.webp` is reported as a
    // skip instead of silently replacing the user's file.
    let existing_output = settings.single_file.then(|| {
        output_folder.as_ref().and_then(|folder| {
            let name = settings
                .source
                .file_name()
                .unwrap_or_else(|| OsStr::new("image"));
            let destination = folder.join(name).with_extension("webp");
            destination.exists().then_some(destination)
        })
    });
    let existing_output = existing_output.flatten();

    let started = Instant::now();
    let result = if let Some(destination) = existing_output {
        convert::ConvertResult {
            summary: convert::Summary {
                failed_files: 1,
                ..Default::default()
            },
            file_errors: vec![convert::FileError {
                path: settings.source.clone(),
                category: "Output file already exists",
                message: format!(
                    "Refusing to overwrite {}. Remove it or choose a different --out folder.",
                    destination.display()
                ),
            }],
        }
    } else if settings.dry_run {
        convert::preview(&files, &settings.source_root, settings.single_file)
    } else {
        let progress_bar = if settings.no_progress {
            indicatif::ProgressBar::hidden()
        } else {
            ui::progress_bar(files.len())
        };
        convert::convert_all(
            &files,
            &settings,
            output_folder.as_deref().unwrap(),
            progress_bar,
        )
    };
    let elapsed = started.elapsed();

    let report_base = if settings.single_file && settings.report_path.is_none() {
        None
    } else {
        output_folder.as_deref()
    };
    let error_report = if settings.dry_run {
        None
    } else {
        match convert::write_error_report(
            report_base,
            &result.file_errors,
            settings.report_path.as_deref(),
        ) {
            Ok(report) => report,
            Err(error) => {
                eprintln!("Could not write conversion error report: {error}");
                None
            }
        }
    };

    let cancelled = CANCEL_REQUESTED.load(std::sync::atomic::Ordering::SeqCst);
    let failed_total = result.summary.failed_files + result.summary.collision_files;

    let exit_code = if cancelled {
        ui::print_cancelled(
            &result,
            output_folder.as_deref().unwrap_or(&settings.source_root),
            elapsed,
        );
        CANCELLED_EXIT_CODE
    } else {
        if settings.dry_run {
            ui::print_dry_run(&result.summary, discovered, &result.file_errors, elapsed);
        } else if let Some(output_folder) = &output_folder {
            ui::print_summary(
                &result.summary,
                output_folder,
                elapsed,
                &result.file_errors,
                error_report.as_deref(),
            );
            ui::maybe_open_output_folder(
                output_folder,
                result.summary.converted_files,
                allow_prompt,
            );
        }
        // Exit non-zero only when nothing converted (a hard failure) or the
        // user interrupted. A dry run is a plan, not a conversion, so it never
        // trips the "nothing converted" rule.
        if settings.fail_on_error && failed_total > 0 {
            FAILURES_EXIT_CODE
        } else if !settings.dry_run && result.summary.converted_files == 0 && failed_total > 0 {
            TOTAL_FAILURE_EXIT_CODE
        } else {
            0
        }
    };

    if settings.json {
        emit_result(
            &settings,
            &result,
            output_folder.as_deref(),
            discovered,
            elapsed.as_millis() as u64,
            cancelled,
            error_report.as_deref(),
        );
    }

    Ok(ExitCode::from(exit_code))
}

#[allow(clippy::too_many_arguments)]
fn emit_result(
    settings: &settings::Settings,
    result: &convert::ConvertResult,
    output_folder: Option<&Path>,
    discovered: usize,
    elapsed_ms: u64,
    cancelled: bool,
    report_path: Option<&Path>,
) {
    report::emit_json(&report::result_json(
        settings,
        result,
        output_folder,
        discovered,
        elapsed_ms,
        cancelled,
        report_path,
    ));
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
        assert_eq!(FAILURES_EXIT_CODE, 4);
        assert_eq!(EMPTY_EXIT_CODE, 5);
        assert_eq!(CANCELLED_EXIT_CODE, 130);
    }
}

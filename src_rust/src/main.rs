mod utils;

use utils::{get_image_files, get_user_input};

use std::{sync::{Arc, atomic::{AtomicUsize, Ordering}, Mutex}, time::Instant};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use rayon::prelude::*;

use crate::utils::{process_file, create_output_folder, initialize_progress_bar, print_completion_message, print_separator};
const OUTPUT_IMAGE_FORMAT: &str = "WebP";
const DEFAULT_QUALITY: i32 = 80;
const DEFAULT_THREADS: usize = 16;

#[derive(Debug)]
struct UserSettings {
    source_folder: PathBuf,
    quality: i32,
    threads: usize,
}

fn get_user_settings() -> UserSettings {
    let source_folder: PathBuf = get_user_input(
        "Enter the path to the source folder: ",
        |path: &PathBuf| path.is_dir(),
        |input: &str| PathBuf::from_str(input).map_err(|_| "Invalid path.".to_string()),
        "Invalid directory path. Please enter a valid path.",
        None,
    );

    let quality: i32 = get_user_input(
        &format!("Enter the quality (default {}): ", DEFAULT_QUALITY),
        |num: &i32| *num > 0,
        |input: &str| i32::from_str(input).map_err(|_| "Invalid input. Please enter a valid number.".to_string()),
        "Invalid input. Please enter a valid number.",
        Some(DEFAULT_QUALITY),
    );

    let threads: usize = get_user_input(
        &format!("Enter the number of threads (default {}): ", DEFAULT_THREADS),
        |num: &usize| *num > 0,
        |input: &str| usize::from_str(input).map_err(|_| "Invalid input. Please enter a valid number.".to_string()),
        "Invalid input. Please enter a valid number.",
        Some(DEFAULT_THREADS),
    );

    UserSettings {
        source_folder,
        quality: quality.try_into().unwrap(),
        threads,
    }
}

fn process_files(image_files: &[PathBuf], settings: &UserSettings, output_folder_path: &Path) {
    // Convert quality outside the loop
    let quality: u8 = match settings.quality.try_into() {
        Ok(q) => q,
        Err(_) => {
            eprintln!("Failed to convert quality setting");
            return;
        }
    };

    let counter: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
    let progress_bar: indicatif::ProgressBar = initialize_progress_bar(image_files.len());
    let errors: Arc<Mutex<Vec<anyhow::Error>>> = Arc::new(Mutex::new(Vec::new()));

    // Calculate batch size
    let batch_size: usize = (image_files.len() / (settings.threads * 32)).max(1);

    image_files.par_chunks(batch_size).for_each_with((counter.clone(), errors.clone()), |(counter, errors), batch| {
        batch.iter().for_each(|file: &PathBuf| {
            match process_file(file, &settings.source_folder, output_folder_path, quality, OUTPUT_IMAGE_FORMAT) {
            Ok(_) => {},
                Err(e) => {
                    let mut errors: std::sync::MutexGuard<'_, Vec<anyhow::Error>> = errors.lock().unwrap();
                    errors.push(e);
                }
            }
        });
        counter.fetch_add(1, Ordering::Relaxed);
        if counter.load(Ordering::Relaxed) % 10 == 0 {
            progress_bar.set_position(counter.load(Ordering::Relaxed) as u64);
        }
    });

    progress_bar.set_position(image_files.len() as u64);
    progress_bar.finish_with_message("Processing complete");

    // Handle errors after processing
    let errors: Vec<anyhow::Error> = Arc::try_unwrap(errors).unwrap().into_inner().unwrap();
    if !errors.is_empty() {
        eprintln!("Errors occurred during processing:");
        for error in errors {
            eprintln!("{}", error);
        }
    }
}

fn main() {
    print_separator();
    let settings: UserSettings = get_user_settings();
    let image_files: Vec<PathBuf> = get_image_files(&settings.source_folder);

    let output_folder_path: PathBuf = create_output_folder(&settings.source_folder, OUTPUT_IMAGE_FORMAT)
        .expect("Failed to create output folder");
    println!("{:?}", output_folder_path);

    let progress_bar: indicatif::ProgressBar = initialize_progress_bar(image_files.len());
    
    let start_time: Instant = Instant::now();
    process_files(&image_files, &settings, &output_folder_path);

    progress_bar.finish_with_message("Processing complete");
    print_completion_message(start_time);
}
use anyhow::Result; 
use rand::Rng;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use indicatif::{ProgressBar, ProgressStyle};
use walkdir::WalkDir;
use std::fs::{self, File};
use std::io::{self, Write, ErrorKind, BufWriter};
use std::ffi::OsStr;
use image::{self, ImageError};
use webp::Encoder;

pub(crate) fn get_image_files(source_folder: &Path) -> Vec<PathBuf> {
    let image_extensions = vec!["jpg", "jpeg", "png" /*, other extensions */];
    let mut image_files = Vec::new();

    for entry in WalkDir::new(source_folder)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
    {
        if let Some(ext) = entry.path().extension().and_then(OsStr::to_str) {
            if image_extensions.iter().any(|&image_ext| image_ext.eq_ignore_ascii_case(ext)) {
                image_files.push(entry.into_path());
            }
        }
    }
    image_files
}

pub(crate) fn validate_input<T, F>(
    converted_input: Option<T>,
    validation_func: F,
    error_message: &str,
) -> Option<T>
where
    T: std::fmt::Debug,
    F: Fn(&T) -> bool,
{
    match converted_input {
        Some(input) if validation_func(&input) => Some(input),
        Some(_) => {
            eprintln!("{}", error_message);
            None
        }
        None => None,
    }
}

pub(crate) fn get_user_input<T, F, G>(
    prompt: &str,
    validation_func: F,
    conversion_func: G,
    error_message: &str,
    default: Option<T>,
) -> T
where
    T: std::fmt::Debug + Clone,
    F: Fn(&T) -> bool,
    G: Fn(&str) -> Result<T, String>,
{
    let default_clone: Option<T> = default.clone();
    loop {
        println!("{}", prompt);
        let mut user_input: String = String::new();
        if io::stdin().read_line(&mut user_input).is_err() {
            eprintln!("Failed to read input");
            continue;
        }

        let trimmed_input: &str = user_input.trim();
        let converted_input: Result<T, String> = conversion_func(trimmed_input);

        match validate_input(converted_input.ok(), &validation_func, error_message) {
            Some(valid_input) => return valid_input,
            None => {
                if let Some(default_value) = &default_clone {
                    return default_value.clone();
                }
            }
        }
    }
}

// Custom error type for operation cancellation.
#[derive(Debug)]
struct OperationCancelledError;

impl std::fmt::Display for OperationCancelledError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Operation cancelled by the user.")
    }
}

impl std::error::Error for OperationCancelledError {}

pub(crate) fn create_output_folder(source_folder: &Path, format: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let output_folder = source_folder.parent()
        .ok_or("Invalid source folder path")?
        .join(format!("{}_{}", source_folder.file_name().ok_or("Invalid source folder path")?.to_str().ok_or("Path is not valid UTF-8")?, format.to_lowercase()));

    if output_folder.is_dir() {
        print!("Output folder already exists. Do you want to replace it? (y/n): ");
        io::stdout().flush()?; // Ensure the prompt is displayed immediately

        let mut user_input = String::new();
        io::stdin().read_line(&mut user_input)?;

        if user_input.trim().eq_ignore_ascii_case("n") {
            return Err(Box::new(OperationCancelledError));
        }

        fs::remove_dir_all(&output_folder)?;
    }

    fs::create_dir_all(&output_folder)?;
    Ok(output_folder)
}

pub(crate) fn process_file(file_path: &Path, source_folder: &Path, output_folder: &Path, quality: u8, format: &str) -> Result<(u64, u64, u32)> {
    let relative_path = file_path.strip_prefix(source_folder)?;
    let mut output_file_path = PathBuf::from(output_folder);
    output_file_path.push(relative_path);
    output_file_path.set_extension(format.to_lowercase());

    if let Some(parent) = output_file_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let original_size = fs::metadata(file_path)?.len();

    match image::open(file_path) {
        Ok(img) => {
            // Convert to WebP and save
            let img: image::ImageBuffer<image::Rgba<u8>, Vec<u8>> = img.to_rgba8();
            let (width, height) = img.dimensions();
            let encoder: Encoder<'_> = Encoder::from_rgba(&img, width, height);
            let webp_data: webp::WebPMemory = encoder.encode(quality as f32);

            let file = File::create(&output_file_path)?;
            let mut writer = BufWriter::new(file);
            writer.write_all(&webp_data)?;
        }
        Err(e) => {
            match e {
                ImageError::IoError(ref e) if e.kind() == ErrorKind::NotFound => 
                    return Err(Box::new(std::io::Error::new(e.kind(), "File not found")).into()),
                _ => return Err(Box::new(e).into()),
            }
        }
    }

    let converted_size = fs::metadata(&output_file_path)?.len();

    Ok((original_size, converted_size, 1))
}

pub(crate) fn initialize_progress_bar(length: usize) -> ProgressBar {
    let style = ProgressStyle::default_bar()
        .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({eta})")
        .expect("Invalid progress bar template") // Handling the Result here
        .progress_chars("##-"); // Now calling progress_chars on ProgressStyle

    let progress_bar = ProgressBar::new(length as u64);
    progress_bar.set_style(style);
    progress_bar.enable_steady_tick(Duration::from_millis(100));

    progress_bar
}

pub(crate) fn print_completion_message(start_time: Instant) {
    let duration = start_time.elapsed();
    println!("Total time taken: {:?} seconds", duration.as_secs());
}

pub(crate) fn print_separator() {
    // ASCII Art separators
    let ascii_art_separators = [
        "------------------------------------------------------------\n\
                            PicToWebP 🖼️➡️🌐\n\
         ------------------------------------------------------------\n\n",
        "************************************************************\n\
                            PicToWebP 🖼️➡️🌐\n\
         ************************************************************\n\n",
        "############################################################\n\
                            PicToWebP 🖼️➡️🌐\n\
         ############################################################\n\n",
        "==================== PicToWebP 🖼️➡️🌐 ====================\n\
         ============================================================\n\n",
    ];

    // Create a random number generator
    let mut rng = rand::thread_rng();

    // Randomly select and print a separator
    println!("{}", ascii_art_separators[rng.gen_range(0..ascii_art_separators.len())]);
}
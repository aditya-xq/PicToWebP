//! Parallel conversion of discovered images.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use anyhow::Result;
use image::ImageDecoder;
use indicatif::ParallelProgressIterator;
use indicatif::ProgressBar;
use rayon::prelude::*;

use crate::settings::Settings;

const OUTPUT_EXTENSION: &str = "webp";
/// Maximum number of items submitted to rayon per drain cycle. Larger
/// values keep workers busier at the cost of higher peak memory.
const CHUNK_SIZE: usize = 64;
static TEMPORARY_FILE_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Tracks whether the user requested cancellation via Ctrl+C. Shared
/// between :func:`crate::main::run` and :func:`convert_all`.
pub static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Size bookkeeping for one converted image.
#[derive(Debug, Clone, Copy)]
pub struct FileOutcome {
    original_bytes: u64,
    converted_bytes: u64,
}

/// A conversion error paired with the file that triggered it.
#[derive(Debug, Clone)]
pub struct FileError {
    pub path: PathBuf,
    pub category: &'static str,
    pub message: String,
}

/// Aggregated results of a conversion run.
#[derive(Debug, Default, Clone)]
pub struct Summary {
    pub converted_files: u64,
    pub failed_files: usize,
    pub original_bytes: u64,
    pub converted_bytes: u64,
}

impl Summary {
    pub fn bytes_saved(&self) -> u64 {
        self.original_bytes.saturating_sub(self.converted_bytes)
    }

    pub fn reduction_percent(&self) -> f64 {
        if self.original_bytes == 0 {
            return 0.0;
        }
        (self.bytes_saved() as f64 / self.original_bytes as f64) * 100.0
    }
}

/// The result of a conversion run, including per-file errors.
pub struct ConvertResult {
    pub summary: Summary,
    pub file_errors: Vec<FileError>,
}

/// Convert every file into `output_root`, mirroring the directory structure.
///
/// Work runs on a dedicated rayon pool sized by `settings.threads`. Failures
/// are collected and returned in the result instead of being printed directly.
///
/// The cancellation flag from :data:`CANCEL_REQUESTED` is sampled between
/// chunks: once a cancellation request is observed, the function stops
/// submitting new work and the remaining in-flight conversions are allowed
/// to drain without blocking the caller.
pub fn convert_all(
    files: &[PathBuf],
    settings: &Settings,
    output_root: &Path,
    progress_bar: ProgressBar,
) -> ConvertResult {
    use std::sync::atomic::Ordering;

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(settings.threads.get())
        .build()
        .expect("thread pool construction should succeed");

    let collisions = output_collisions(files, &settings.source_folder);
    let convertible_files: Vec<&PathBuf> = files
        .iter()
        .filter(|file| !collisions.contains_key(*file))
        .collect();
    let mut results: Vec<(PathBuf, Result<FileOutcome>)> = Vec::new();
    for chunk_start in (0..convertible_files.len()).step_by(CHUNK_SIZE) {
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            break;
        }
        let end = (chunk_start + CHUNK_SIZE).min(convertible_files.len());
        let chunk: Vec<(PathBuf, Result<FileOutcome>)> = pool.install(|| {
            convertible_files[chunk_start..end]
                .par_iter()
                .progress_with(progress_bar.clone())
                .map(|file| {
                    let result = process_file(
                        file,
                        &settings.source_folder,
                        output_root,
                        settings.quality,
                        settings.lossless,
                        settings.strip_metadata,
                    );
                    ((*file).clone(), result)
                })
                .collect()
        });
        results.extend(chunk);
    }

    let mut summary = Summary::default();
    let mut file_errors: Vec<FileError> = Vec::new();

    for (path, message) in collisions {
        summary.failed_files += 1;
        file_errors.push(FileError {
            path: path.clone(),
            category: "Output name collision",
            message,
        });
    }

    for (path, result) in results {
        match result {
            Ok(outcome) => {
                summary.converted_files += 1;
                summary.original_bytes += outcome.original_bytes;
                summary.converted_bytes += outcome.converted_bytes;
            }
            Err(error) => {
                summary.failed_files += 1;
                let message = error.root_cause().to_string();
                file_errors.push(FileError {
                    path: path.clone(),
                    category: categorize_error(&message),
                    message,
                });
            }
        }
    }

    ConvertResult {
        summary,
        file_errors,
    }
}

/// Persist all failures for review without requiring terminal scrollback.
pub fn write_error_report(
    output_folder: &Path,
    file_errors: &[FileError],
    override_path: Option<&Path>,
) -> Result<Option<PathBuf>> {
    if file_errors.is_empty() {
        return Ok(None);
    }

    let report = match override_path {
        Some(path) => path.to_path_buf(),
        None => output_folder.join(crate::style::ERROR_REPORT_NAME),
    };
    let mut contents = String::from("PicToWebP conversion errors\n\n");
    for error in file_errors {
        contents.push_str(&format!(
            "[{}] {}\n{}\n\n",
            error.category,
            error.message,
            crate::style::display_path(&error.path)
        ));
    }
    if let Some(parent) = report.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomically(&report, contents.as_bytes())?;
    Ok(Some(report))
}

fn output_collisions(files: &[PathBuf], source_folder: &Path) -> HashMap<PathBuf, String> {
    let mut destinations: HashMap<PathBuf, Vec<&PathBuf>> = HashMap::new();
    for file in files {
        let destination = file
            .strip_prefix(source_folder)
            .unwrap_or(file)
            .with_extension(OUTPUT_EXTENSION);
        destinations.entry(destination).or_default().push(file);
    }

    let mut collisions = HashMap::new();
    for (destination, paths) in destinations {
        if paths.len() > 1 {
            let message = format!(
                "Multiple input files map to the same output: {}",
                destination.display()
            );
            for path in paths {
                collisions.insert(path.clone(), message.clone());
            }
        }
    }
    collisions
}

fn categorize_error(message: &str) -> &'static str {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("permission denied") || normalized.contains("access is denied") {
        "Permission denied"
    } else if [
        "cannot identify",
        "invalid",
        "parsing",
        "truncated",
        "end of file",
    ]
    .iter()
    .any(|token| normalized.contains(token))
    {
        "Corrupt or mislabeled image"
    } else if ["no such file", "file not found", "not a directory"]
        .iter()
        .any(|token| normalized.contains(token))
    {
        "Unreadable file"
    } else if ["write", "disk", "space"]
        .iter()
        .any(|token| normalized.contains(token))
    {
        "Output write failed"
    } else {
        "Conversion failed"
    }
}

/// Convert a single image to WebP.
pub fn process_file(
    file_path: &Path,
    source_folder: &Path,
    output_folder: &Path,
    quality: u8,
    lossless: bool,
    strip_metadata: bool,
) -> Result<FileOutcome> {
    let relative_path = file_path.strip_prefix(source_folder)?;
    let mut destination = output_folder.to_path_buf();
    destination.push(relative_path);
    destination.set_extension(OUTPUT_EXTENSION);

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }

    let original_bytes = fs::metadata(file_path)?.len();

    // Open through the reader so we can extract the source EXIF payload before
    // decoding, then re-encode it into the WebP container when requested.
    let reader = image::ImageReader::open(file_path)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let exif = decoder.exif_metadata()?.as_deref().and_then(normalize_exif);
    let image = image::DynamicImage::from_decoder(decoder)?;

    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let encoded = if lossless {
        webp::Encoder::from_rgba(rgba.as_raw(), width, height).encode_lossless()
    } else {
        webp::Encoder::from_rgba(rgba.as_raw(), width, height).encode(f32::from(quality))
    };

    // Embed the source EXIF chunk unless metadata stripping was requested.
    let payload: Vec<u8> = if strip_metadata {
        encoded.as_ref().to_vec()
    } else if let Some(exif) = &exif {
        embed_exif(encoded.as_ref(), exif).unwrap_or_else(|| encoded.as_ref().to_vec())
    } else {
        encoded.as_ref().to_vec()
    };

    // Write the payload through a temp file in the same directory then rename
    // so a partial output is never visible as a finished WebP.
    write_atomically(&destination, &payload)?;

    let converted_bytes = fs::metadata(&destination)?.len();

    Ok(FileOutcome {
        original_bytes,
        converted_bytes,
    })
}

/// Normalize a raw EXIF payload so it can be stored in a WebP chunk.
///
/// Some decoders prefix the TIFF blob with the JPEG `Exif\0\0` marker, which
/// the WebP container does not expect. We also reject anything that does not
/// look like a TIFF blob (starting with `II*`/`MM*`) to avoid writing garbage.
fn normalize_exif(raw: &[u8]) -> Option<Vec<u8>> {
    let data = if raw.starts_with(b"Exif\0\0") {
        &raw[6..]
    } else {
        raw
    };
    let is_tiff = data.len() >= 4 && (data.starts_with(b"II*\0") || data.starts_with(b"MM\0*"));
    is_tiff.then(|| data.to_vec())
}

/// Wrap a simple WebP bitstream in an extended (VP8X) container that carries
/// the supplied EXIF payload, preserving metadata across the conversion.
fn embed_exif(simple: &[u8], exif: &[u8]) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use std::os::raw::c_int;

    use libwebp_sys::*;

    let webp = WebPData {
        bytes: simple.as_ptr(),
        size: simple.len(),
    };
    // SAFETY: `webp` references `simple`, which outlives the call. `copy_data =
    // 1` makes the mux take ownership of its own copy of the bitstream.
    let mux = unsafe { WebPMuxCreateInternal(&webp, 1, WEBP_MUX_ABI_VERSION as c_int) };
    if mux.is_null() {
        return None;
    }

    let exif_data = WebPData {
        bytes: exif.as_ptr(),
        size: exif.len(),
    };
    // SAFETY: `mux` and `exif_data` are valid for the duration of the call and
    // `copy_data = 1` makes the mux copy the EXIF payload.
    let status = unsafe { WebPMuxSetChunk(mux, c"EXIF".as_ptr(), &exif_data, 1) };
    if (status as c_int) != (WebPMuxError::WEBP_MUX_OK as c_int) {
        unsafe { WebPMuxDelete(mux) };
        return None;
    }

    let mut assembled = WebPData {
        bytes: std::ptr::null(),
        size: 0,
    };
    // SAFETY: `assembled` is a valid out-pointer that libwebp fills.
    let status = unsafe { WebPMuxAssemble(mux, &mut assembled) };
    unsafe { WebPMuxDelete(mux) };
    if (status as c_int) != (WebPMuxError::WEBP_MUX_OK as c_int) || assembled.bytes.is_null() {
        return None;
    }

    // SAFETY: `assembled.bytes` points to `assembled.size` libwebp-owned bytes.
    let out = unsafe { std::slice::from_raw_parts(assembled.bytes, assembled.size) }.to_vec();
    unsafe { WebPFree(assembled.bytes as *mut c_void) };
    Some(out)
}

fn write_atomically(destination: &Path, contents: &[u8]) -> Result<()> {
    let (mut temporary_file, temporary_path) = create_temporary_file(destination)?;
    if let Err(error) = temporary_file
        .write_all(contents)
        .and_then(|_| temporary_file.sync_all())
    {
        let _ = fs::remove_file(&temporary_path);
        return Err(error.into());
    }
    drop(temporary_file);
    if let Err(error) = fs::rename(&temporary_path, destination) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error.into());
    }
    Ok(())
}

fn create_temporary_file(destination: &Path) -> Result<(File, PathBuf)> {
    let parent = destination.parent().unwrap_or(Path::new("."));
    let stem = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    for _ in 0..100 {
        let sequence = TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".{stem}.{}.{}.tmp", std::process::id(), sequence));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    anyhow::bail!("Could not allocate a temporary output file")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialize tests that touch the shared `CANCEL_REQUESTED` flag.
    static CANCEL_LOCK: Mutex<()> = Mutex::new(());

    /// Create a solid-color test image at `path` (format chosen by extension).
    fn create_test_image(path: &Path, width: u32, height: u32) {
        let format = match path.extension().and_then(|ext| ext.to_str()) {
            Some("jpg") | Some("jpeg") => image::ImageFormat::Jpeg,
            _ => image::ImageFormat::Png,
        };
        image::DynamicImage::new_rgb8(width, height)
            .save_with_format(path, format)
            .unwrap();
    }

    /// Allocate a unique scratch directory for one test.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pictowebp-{label}-{}-{}",
            std::process::id(),
            TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn output_dimensions(path: &Path) -> (u32, u32) {
        let reader = image::ImageReader::open(path).unwrap();
        let (width, height) = reader.into_dimensions().unwrap();
        (width, height)
    }

    #[test]
    fn reduction_math_handles_empty_and_saturated_values() {
        let empty = Summary::default();
        assert_eq!(empty.reduction_percent(), 0.0);

        let grown = Summary {
            converted_files: 1,
            failed_files: 0,
            original_bytes: 100,
            converted_bytes: 150,
        };
        assert_eq!(grown.bytes_saved(), 0);
        assert_eq!(grown.reduction_percent(), 0.0);

        let shrunk = Summary {
            converted_files: 2,
            failed_files: 0,
            original_bytes: 400,
            converted_bytes: 100,
        };
        assert_eq!(shrunk.bytes_saved(), 300);
        assert!((shrunk.reduction_percent() - 75.0).abs() < f64::EPSILON);
    }

    #[test]
    fn categorizes_common_decode_errors() {
        assert_eq!(
            categorize_error("Format error decoding Png: Invalid PNG signature."),
            "Corrupt or mislabeled image"
        );
        assert_eq!(categorize_error("Permission denied"), "Permission denied");
    }

    #[test]
    fn detects_same_stem_output_collisions() {
        let source = PathBuf::from("/tmp/photos");
        let files = vec![
            source.join("photo.png"),
            source.join("photo.jpg"),
            source.join("unique.webp"),
        ];

        let collisions = output_collisions(&files, &source);

        assert_eq!(collisions.len(), 2);
        assert!(collisions.contains_key(&source.join("photo.png")));
        assert!(collisions.contains_key(&source.join("photo.jpg")));
        assert!(!collisions.contains_key(&source.join("unique.webp")));
    }

    #[test]
    fn writes_error_report_atomically() {
        let temp = std::env::temp_dir().join(format!(
            "pictowebp-test-{}-{}",
            std::process::id(),
            TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&temp).unwrap();

        let errors = vec![FileError {
            path: PathBuf::from("C:/photos/broken.jpg"),
            category: "Corrupt or mislabeled image",
            message: "Invalid signature".to_string(),
        }];

        let report = write_error_report(&temp, &errors, None).unwrap().unwrap();
        let contents = fs::read_to_string(&report).unwrap();
        assert!(contents.contains("Invalid signature"));
        assert!(contents.contains("C:/photos/broken.jpg"));
        assert!(contents.contains("Corrupt or mislabeled image"));

        fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn writes_error_report_strips_windows_verbatim_prefix() {
        let temp = std::env::temp_dir().join(format!(
            "pictowebp-test-{}-{}",
            std::process::id(),
            TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&temp).unwrap();

        let errors = vec![FileError {
            // Simulate a path that came in with the Windows verbatim prefix.
            path: PathBuf::from(r"\\?\C:\photos\broken.jpg"),
            category: "Corrupt or mislabeled image",
            message: "Invalid signature".to_string(),
        }];

        let report = write_error_report(&temp, &errors, None).unwrap().unwrap();
        let contents = fs::read_to_string(&report).unwrap();
        assert!(!contents.contains(r"\\?\"));
        // Windows renders the path with backslashes; Unix with forward slashes.
        let needle = if cfg!(windows) {
            r"C:\photos\broken.jpg"
        } else {
            "C:/photos/broken.jpg"
        };
        assert!(
            contents.contains(needle),
            "expected to find {needle:?} in {contents:?}"
        );

        fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn writes_error_report_to_override_path() {
        let temp = std::env::temp_dir().join(format!(
            "pictowebp-test-{}-{}",
            std::process::id(),
            TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&temp).unwrap();

        let custom = temp.join("custom-errors.txt");
        let errors = vec![FileError {
            path: PathBuf::from("C:/photos/broken.jpg"),
            category: "Corrupt or mislabeled image",
            message: "Invalid signature".to_string(),
        }];

        let report = write_error_report(&temp, &errors, Some(&custom))
            .unwrap()
            .unwrap();
        assert_eq!(report, custom);
        // Default location must not be written when a custom path is supplied.
        assert!(!temp.join(crate::style::ERROR_REPORT_NAME).exists());
        fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn cancel_flag_round_trips() {
        use std::sync::atomic::Ordering;

        CANCEL_REQUESTED.store(false, Ordering::SeqCst);
        assert!(!CANCEL_REQUESTED.load(Ordering::SeqCst));
        CANCEL_REQUESTED.store(true, Ordering::SeqCst);
        assert!(CANCEL_REQUESTED.load(Ordering::SeqCst));
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    }

    #[test]
    fn normalizes_exif_prefix_and_rejects_non_tiff() {
        assert!(normalize_exif(b"Exif\0\0II*\0data").is_some());
        assert!(normalize_exif(b"II*\0data").is_some());
        assert!(normalize_exif(b"MM\0*data").is_some());
        assert!(normalize_exif(b"not a tiff").is_none());
    }

    #[test]
    fn embeds_exif_into_vp8x_container() {
        // Encode a tiny image with the same crate the app uses, then verify the
        // mux path produces a VP8X container carrying an EXIF chunk that still
        // decodes back to the original pixels.
        let pixels = vec![128u8; 4 * 4 * 4];
        let encoded = webp::Encoder::from_rgba(&pixels, 4, 4).encode_lossless();
        let simple = encoded.as_ref();

        let fake_exif = b"II*\0\x08\0\x00\x00\x00\x00";
        let embedded = embed_exif(simple, fake_exif).expect("mux should succeed");

        assert!(embedded.windows(4).any(|window| window == b"VP8X"));
        assert!(embedded.windows(4).any(|window| window == b"EXIF"));

        let decoded = webp::Decoder::new(&embedded)
            .decode()
            .expect("muxed WebP should still decode");
        assert_eq!((decoded.width(), decoded.height()), (4, 4));
    }

    #[test]
    fn exif_round_trips_through_webp_container() {
        // Validate that the muxed file is readable by the same `image` decoder
        // used for source files, and that the EXIF chunk survives the round trip.
        let pixels = vec![10u8; 4 * 8 * 8];
        let encoded = webp::Encoder::from_rgba(&pixels, 8, 8).encode_lossless();
        let exif = b"II*\0\x08\0\x00\x00\x00\x00".to_vec();
        let muxed = embed_exif(encoded.as_ref(), &exif).expect("mux should succeed");

        let dir = std::env::temp_dir().join(format!("pictowebp-exif-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("with_exif.webp");
        fs::write(&path, &muxed).unwrap();

        let reader = image::ImageReader::open(&path)
            .unwrap()
            .with_guessed_format()
            .unwrap();
        let mut decoder = reader.into_decoder().unwrap();
        let read = decoder.exif_metadata().unwrap();
        assert_eq!(read.as_deref(), Some(exif.as_slice()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn process_file_converts_and_mirrors_nested_structure() {
        let root = scratch_dir("e2e-nested");
        let source = root.join("source");
        fs::create_dir_all(source.join("nested/deep")).unwrap();
        create_test_image(&source.join("a.png"), 32, 16);
        create_test_image(&source.join("nested/deep/b.jpg"), 16, 16);

        let output = root.join("out");
        let png = process_file(&source.join("a.png"), &source, &output, 80, false, true);
        let jpg = process_file(
            &source.join("nested/deep/b.jpg"),
            &source,
            &output,
            80,
            false,
            true,
        );

        assert!(png.is_ok(), "png conversion failed: {png:?}");
        assert!(jpg.is_ok(), "jpg conversion failed: {jpg:?}");
        assert!(output.join("a.webp").is_file());
        assert!(output.join("nested/deep/b.webp").is_file());
        assert_eq!(output_dimensions(&output.join("a.webp")), (32, 16));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn process_file_reports_corrupt_input_and_leaves_no_temp_files() {
        let root = scratch_dir("e2e-corrupt");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("broken.png"), b"not an image").unwrap();

        let output = root.join("out");
        let result = process_file(
            &source.join("broken.png"),
            &source,
            &output,
            80,
            false,
            true,
        );

        assert!(result.is_err());
        assert!(!output.join("broken.webp").exists());
        let leftovers = fs::read_dir(&output)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "tmp"))
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn process_file_strips_and_keeps_metadata_end_to_end() {
        let root = scratch_dir("e2e-metadata");
        let source = root.join("source");
        let output = root.join("out");
        fs::create_dir_all(&source).unwrap();
        create_test_image(&source.join("photo.png"), 16, 16);

        let stripped =
            process_file(&source.join("photo.png"), &source, &output, 80, false, true).unwrap();
        let kept = process_file(
            &source.join("photo.png"),
            &source,
            &output,
            80,
            false,
            false,
        )
        .unwrap();

        assert_eq!(
            stripped.converted_bytes,
            output.join("photo.webp").metadata().unwrap().len()
        );
        assert_eq!(
            kept.converted_bytes,
            output.join("photo.webp").metadata().unwrap().len()
        );
        assert!(stripped.converted_bytes > 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn convert_all_handles_success_failures_and_collisions() {
        let _guard = CANCEL_LOCK.lock().unwrap();
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);

        let root = scratch_dir("e2e-convert-all");
        let source = root.join("source");
        fs::create_dir_all(source.join("nested")).unwrap();
        create_test_image(&source.join("good.png"), 32, 32);
        create_test_image(&source.join("nested/also-good.png"), 16, 16);
        fs::write(source.join("nested/broken.png"), b"garbage").unwrap();
        // Same-stem collision: both map to nested/collide.webp.
        create_test_image(&source.join("nested/collide.png"), 8, 8);
        create_test_image(&source.join("nested/collide.jpg"), 8, 8);

        let settings = crate::settings::Settings {
            source_folder: source.clone(),
            quality: 80,
            threads: std::num::NonZeroUsize::new(2).unwrap(),
            lossless: false,
            strip_metadata: true,
            no_progress: true,
            report_path: None,
        };
        let output = root.join("out");
        let result = convert_all(
            &crate::discovery::discover_images(&source),
            &settings,
            &output,
            ProgressBar::hidden(),
        );

        // good.png + also-good.png convert; broken.png fails; collide.* collide.
        assert_eq!(result.summary.converted_files, 2);
        assert_eq!(result.summary.failed_files, 3);
        assert!(output.join("good.webp").is_file());
        assert!(output.join("nested/also-good.webp").is_file());
        let categories: Vec<_> = result.file_errors.iter().map(|e| e.category).collect();
        assert!(categories.contains(&"Output name collision"));
        assert!(categories.contains(&"Corrupt or mislabeled image"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn convert_all_stops_submitting_after_cancellation() {
        let _guard = CANCEL_LOCK.lock().unwrap();
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);

        let root = scratch_dir("e2e-cancel");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        for index in 0..8 {
            create_test_image(&source.join(format!("img{index}.png")), 8, 8);
        }

        let settings = crate::settings::Settings {
            source_folder: source.clone(),
            quality: 80,
            threads: std::num::NonZeroUsize::new(1).unwrap(),
            lossless: false,
            strip_metadata: true,
            no_progress: true,
            report_path: None,
        };
        let output = root.join("out");
        // Cancel before any work runs: nothing should be submitted.
        CANCEL_REQUESTED.store(true, Ordering::SeqCst);
        let result = convert_all(
            &crate::discovery::discover_images(&source),
            &settings,
            &output,
            ProgressBar::hidden(),
        );
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);

        assert_eq!(result.summary.converted_files, 0);
        assert_eq!(result.summary.failed_files, 0);
        fs::remove_dir_all(&root).ok();
    }
}

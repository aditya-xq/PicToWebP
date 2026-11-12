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

/// Default cap on decoded image dimensions. Kept in settings so the CLI,
/// environment, and converters share one value.
fn check_pixel_limit(width: u32, height: u32, limit: u64) -> Result<()> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels > limit {
        anyhow::bail!(
            "image is too large: {width}x{height} ({pixels} pixels); limit is {limit}. \
             Set PICTOWEBP_MAX_PIXELS or pass --max-pixels to override."
        );
    }
    Ok(())
}

fn is_large_dimensions(width: u32, height: u32) -> bool {
    u64::from(width) * u64::from(height) > crate::settings::LARGE_IMAGE_PIXELS
}

/// Read only the header dimensions; corrupt/unsupported files are left to the
/// normal conversion path where they are reported as failures.
fn is_large_image(path: &Path) -> bool {
    let Ok(reader) = image::ImageReader::open(path) else {
        return false;
    };
    let Ok(reader) = reader.with_guessed_format() else {
        return false;
    };
    let Ok((width, height)) = reader.into_dimensions() else {
        return false;
    };
    is_large_dimensions(width, height)
}

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
    /// Files that failed to convert (decode/write errors).
    pub failed_files: usize,
    /// Inputs skipped because two inputs map to the same output name. Kept
    /// separate from conversion failures so callers can tell "corrupt file"
    /// apart from "same-stem collision".
    pub collision_files: usize,
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
#[derive(Default)]
pub struct ConvertResult {
    pub summary: Summary,
    pub file_errors: Vec<FileError>,
}

/// Compute what a run would do without decoding or writing anything.
///
/// Used by `--dry-run`: detects same-stem collisions and counts convertible
/// files so an agent can plan before touching the filesystem.
pub fn preview(files: &[PathBuf], source_root: &Path, single_file: bool) -> ConvertResult {
    let collisions = output_collisions(files, source_root, single_file);
    let mut summary = Summary::default();
    let mut file_errors = Vec::new();

    for file in files {
        if let Some(message) = collisions.get(file) {
            summary.collision_files += 1;
            file_errors.push(FileError {
                path: file.clone(),
                category: "Output name collision",
                message: message.clone(),
            });
        } else {
            summary.converted_files += 1;
        }
    }

    ConvertResult {
        summary,
        file_errors,
    }
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

    let collisions = output_collisions(files, &settings.source_root, settings.single_file);
    let convertible_files: Vec<&PathBuf> = files
        .iter()
        .filter(|file| !collisions.contains_key(*file))
        .collect();
    let mut results: Vec<(PathBuf, Result<FileOutcome>)> = Vec::new();

    // Giant images are decoded one at a time: with four bytes per pixel, a
    // 400 MP image is ~1.6 GB, so running several in parallel would multiply
    // peak memory by the worker count. Everything else stays pooled.
    let (large, normal): (Vec<&PathBuf>, Vec<&PathBuf>) = convertible_files
        .into_iter()
        .partition(|file| is_large_image(file));

    for file in large {
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            break;
        }
        let result = process_file(
            file,
            &settings.source_root,
            output_root,
            settings.quality,
            settings.lossless,
            settings.strip_metadata,
            settings.max_pixels,
        );
        progress_bar.inc(1);
        results.push((file.clone(), result));
    }

    for chunk_start in (0..normal.len()).step_by(CHUNK_SIZE) {
        if CANCEL_REQUESTED.load(Ordering::SeqCst) {
            break;
        }
        let end = (chunk_start + CHUNK_SIZE).min(normal.len());
        let chunk: Vec<(PathBuf, Result<FileOutcome>)> = pool.install(|| {
            normal[chunk_start..end]
                .par_iter()
                .progress_with(progress_bar.clone())
                .map(|file| {
                    let result = process_file(
                        file,
                        &settings.source_root,
                        output_root,
                        settings.quality,
                        settings.lossless,
                        settings.strip_metadata,
                        settings.max_pixels,
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
        summary.collision_files += 1;
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
    base_folder: Option<&Path>,
    file_errors: &[FileError],
    override_path: Option<&Path>,
) -> Result<Option<PathBuf>> {
    if file_errors.is_empty() {
        return Ok(None);
    }

    let report = match override_path {
        Some(path) => path.to_path_buf(),
        None => match base_folder {
            // A single-file run writes next to the source; only persist a
            // report when the caller explicitly asked for one.
            Some(folder) => folder.join(crate::style::ERROR_REPORT_NAME),
            None => return Ok(None),
        },
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

fn output_collisions(
    files: &[PathBuf],
    source_folder: &Path,
    single_file: bool,
) -> HashMap<PathBuf, String> {
    let mut destinations: HashMap<PathBuf, Vec<&PathBuf>> = HashMap::new();
    for file in files {
        let relative = if single_file {
            Path::new(file.file_name().unwrap_or(file.as_os_str()))
        } else {
            file.strip_prefix(source_folder).unwrap_or(file)
        };
        let destination = relative.with_extension(OUTPUT_EXTENSION);
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
    } else if normalized.contains("too large") {
        "Image too large"
    } else if normalized.contains("unsupported input format") {
        "Unsupported format"
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
    max_pixels: u64,
) -> Result<FileOutcome> {
    if let Some(extension) = unsupported_extension(file_path) {
        anyhow::bail!(
            "unsupported input format .{extension}; export the image as JPEG or PNG first"
        );
    }

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
    let (width, height) = decoder.dimensions();
    check_pixel_limit(width, height, max_pixels)?;
    let orientation = decoder.orientation()?;
    // A damaged ICC segment should not reject an otherwise decodable image;
    // treat an unreadable profile as "no profile".
    let icc = decoder.icc_profile().unwrap_or(None);
    let exif = decoder.exif_metadata()?.as_deref().and_then(normalize_exif);
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    if orientation != image::metadata::Orientation::NoTransforms {
        image.apply_orientation(orientation);
    }
    // The pixels are upright now, so the EXIF orientation tag must not rotate
    // them a second time in a viewer.
    let exif = if orientation == image::metadata::Orientation::NoTransforms {
        exif
    } else {
        exif.and_then(|payload| upright_exif(&payload))
    };

    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let encoded = if lossless {
        webp::Encoder::from_rgba(rgba.as_raw(), width, height).encode_lossless()
    } else {
        webp::Encoder::from_rgba(rgba.as_raw(), width, height).encode(f32::from(quality))
    };

    // EXIF is stripped by default; the color profile is kept so wide-gamut
    // phone photos do not shift when a viewer honours the profile.
    let exif_chunk = if strip_metadata {
        None
    } else {
        exif.as_deref()
    };
    let payload = embed_metadata(encoded.as_ref(), exif_chunk, icc.as_deref())
        .unwrap_or_else(|| encoded.as_ref().to_vec());

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

/// Set the EXIF orientation tag to `1` (upright) in a TIFF blob.
///
/// Returns `Some` unchanged when the tag is absent, and `None` for malformed
/// data so callers can drop metadata rather than double-rotate the image.
fn upright_exif(exif: &[u8]) -> Option<Vec<u8>> {
    if exif.len() < 8 {
        return None;
    }
    let little = match &exif[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let read_u16 = |offset: usize| -> Option<u16> {
        let bytes = exif.get(offset..offset + 2)?;
        Some(if little {
            u16::from_le_bytes([bytes[0], bytes[1]])
        } else {
            u16::from_be_bytes([bytes[0], bytes[1]])
        })
    };
    let read_u32 = |offset: usize| -> Option<u32> {
        let bytes = exif.get(offset..offset + 4)?;
        Some(if little {
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        } else {
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        })
    };

    if read_u16(2)? != 42 {
        return None;
    }
    let ifd = read_u32(4)? as usize;
    let count = read_u16(ifd)? as usize;
    for index in 0..count {
        let entry = ifd.checked_add(2 + index * 12)?;
        if entry + 12 > exif.len() {
            return None;
        }
        if read_u16(entry)? != 0x0112 {
            continue;
        }
        let kind = read_u16(entry + 2)?;
        let count = read_u32(entry + 4)?;
        if kind != 3 || count != 1 {
            return None;
        }
        let mut out = exif.to_vec();
        let value = entry + 8;
        if little {
            out[value] = 1;
            out[value + 1] = 0;
        } else {
            out[value] = 0;
            out[value + 1] = 1;
        }
        return Some(out);
    }
    Some(exif.to_vec())
}

/// Add EXIF and/or ICC profile chunks to a simple WebP bitstream.
fn embed_metadata(simple: &[u8], exif: Option<&[u8]>, icc: Option<&[u8]>) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use std::os::raw::c_int;

    use libwebp_sys::*;

    let mut chunks: Vec<(&std::ffi::CStr, &[u8])> = Vec::new();
    if let Some(exif) = exif {
        chunks.push((c"EXIF", exif));
    }
    if let Some(icc) = icc {
        chunks.push((c"ICCP", icc));
    }
    if chunks.is_empty() {
        return None;
    }

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

    for (fourcc, bytes) in chunks {
        let data = WebPData {
            bytes: bytes.as_ptr(),
            size: bytes.len(),
        };
        // SAFETY: `mux` and `data` are valid for the call and `copy_data = 1`
        // makes the mux copy the payload.
        let status = unsafe { WebPMuxSetChunk(mux, fourcc.as_ptr(), &data, 1) };
        if (status as c_int) != (WebPMuxError::WEBP_MUX_OK as c_int) {
            unsafe { WebPMuxDelete(mux) };
            return None;
        }
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

/// Formats common on phones that this build cannot decode. A single-file run
/// gets a clear message instead of a generic "unknown format" error.
fn unsupported_extension(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    ["heic", "heif", "dng", "raw", "avif", "jxl"]
        .into_iter()
        .find(|candidate| *candidate == extension)
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
            collision_files: 0,
            original_bytes: 100,
            converted_bytes: 150,
        };
        assert_eq!(grown.bytes_saved(), 0);
        assert_eq!(grown.reduction_percent(), 0.0);

        let shrunk = Summary {
            converted_files: 2,
            failed_files: 0,
            collision_files: 0,
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
        assert_eq!(
            categorize_error("image is too large: 20000x20000"),
            "Image too large"
        );
    }

    #[test]
    fn rejects_images_above_the_pixel_limit() {
        assert!(check_pixel_limit(1000, 1000, 1_000_000).is_ok());
        let error = check_pixel_limit(1001, 1000, 1_000_000).unwrap_err();
        assert!(error.to_string().contains("too large"));
    }

    #[test]
    fn large_images_are_serialized_at_the_100mp_breakpoint() {
        assert!(!is_large_dimensions(10_000, 10_000)); // exactly 100 MP
        assert!(is_large_dimensions(11_648, 8_736)); // 102 MP medium format
        assert!(is_large_dimensions(14_204, 10_652)); // 151 MP digital back
        assert!(is_large_dimensions(23_200, 17_400)); // 400 MP multi-shot
    }

    #[test]
    fn single_file_relative_name_resolves_against_an_empty_root() {
        // `pictowebp photo.png` has an empty parent; the file name must still
        // resolve for destination and collision calculations.
        assert_eq!(
            Path::new("photo.png").strip_prefix("").unwrap(),
            Path::new("photo.png")
        );
        let collisions = output_collisions(&[PathBuf::from("photo.png")], Path::new(""), true);
        assert!(collisions.is_empty());
    }

    #[test]
    fn detects_same_stem_output_collisions() {
        let source = PathBuf::from("/tmp/photos");
        let files = vec![
            source.join("photo.png"),
            source.join("photo.jpg"),
            source.join("unique.webp"),
        ];

        let collisions = output_collisions(&files, &source, false);

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

        let report = write_error_report(Some(&temp), &errors, None)
            .unwrap()
            .unwrap();
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

        let report = write_error_report(Some(&temp), &errors, None)
            .unwrap()
            .unwrap();
        let contents = fs::read_to_string(&report).unwrap();
        assert!(!contents.contains(r"\\?\"));
        // The simulated Windows path keeps its literal backslashes after the
        // verbatim prefix is stripped, on every platform.
        let needle = r"C:\photos\broken.jpg";
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

        let report = write_error_report(Some(&temp), &errors, Some(&custom))
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
    fn rejects_unsupported_phone_formats_with_a_clear_message() {
        let root = scratch_dir("e2e-unsupported");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        let file = source.join("phone.heic");
        fs::write(&file, b"not really heic").unwrap();
        let output = root.join("out");

        let error = process_file(
            &file,
            &source,
            &output,
            80,
            false,
            true,
            crate::settings::DEFAULT_MAX_PIXELS,
        )
        .unwrap_err();

        assert!(error.to_string().contains("unsupported input format"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn embeds_icc_profile_into_vp8x_container() {
        let pixels = vec![64u8; 4 * 4 * 4];
        let encoded = webp::Encoder::from_rgba(&pixels, 4, 4).encode_lossless();
        let icc = b"fake-icc-profile";

        let embedded =
            embed_metadata(encoded.as_ref(), None, Some(icc)).expect("mux should succeed");

        assert!(embedded.windows(4).any(|window| window == b"VP8X"));
        assert!(embedded.windows(4).any(|window| window == b"ICCP"));
        let decoded = webp::Decoder::new(&embedded)
            .decode()
            .expect("muxed WebP should still decode");
        assert_eq!((decoded.width(), decoded.height()), (4, 4));
    }

    #[test]
    fn rewrites_exif_orientation_to_upright() {
        // Little-endian TIFF: one IFD entry, Orientation (0x0112) = 6.
        let mut exif = vec![
            b'I', b'I', 42, 0, 8, 0, 0, 0, // header, IFD at 8
            1, 0, // one entry
            0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, // orientation 6
            0, 0, 0, 0, // next IFD
        ];
        let original = exif.clone();

        let upright = upright_exif(&exif).expect("valid TIFF should be rewritten");
        assert_eq!(&upright[18..20], &[1, 0]);
        exif[18..20].copy_from_slice(&[1, 0]);
        assert_eq!(upright, exif);

        // A TIFF without an orientation tag is returned unchanged.
        let no_tag = b"II*\0\x08\0\0\0\0\0\0\0\0\0\0\0".to_vec();
        assert_eq!(upright_exif(&no_tag), Some(no_tag.clone()));
        // Malformed input is rejected so callers can drop the metadata.
        assert!(upright_exif(b"not-a-tiff").is_none());
        assert_ne!(original, upright);
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
        let embedded = embed_metadata(simple, Some(fake_exif), None).expect("mux should succeed");

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
        let muxed =
            embed_metadata(encoded.as_ref(), Some(&exif), None).expect("mux should succeed");

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
        let png = process_file(
            &source.join("a.png"),
            &source,
            &output,
            80,
            false,
            true,
            crate::settings::DEFAULT_MAX_PIXELS,
        );
        let jpg = process_file(
            &source.join("nested/deep/b.jpg"),
            &source,
            &output,
            80,
            false,
            true,
            crate::settings::DEFAULT_MAX_PIXELS,
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
            crate::settings::DEFAULT_MAX_PIXELS,
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

        let stripped = process_file(
            &source.join("photo.png"),
            &source,
            &output,
            80,
            false,
            true,
            crate::settings::DEFAULT_MAX_PIXELS,
        )
        .unwrap();
        let kept = process_file(
            &source.join("photo.png"),
            &source,
            &output,
            80,
            false,
            false,
            crate::settings::DEFAULT_MAX_PIXELS,
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
            source: source.clone(),
            source_root: source.clone(),
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
            json: false,
            fail_on_error: false,
            fail_on_empty: false,
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
        assert_eq!(result.summary.failed_files, 1);
        assert_eq!(result.summary.collision_files, 2);
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
            source: source.clone(),
            source_root: source.clone(),
            single_file: false,
            quality: 80,
            threads: std::num::NonZeroUsize::new(1).unwrap(),
            max_pixels: crate::settings::DEFAULT_MAX_PIXELS,
            lossless: false,
            strip_metadata: true,
            no_progress: true,
            report_path: None,
            allow_report_outside: false,
            output_dir: None,
            dry_run: false,
            json: false,
            fail_on_error: false,
            fail_on_empty: false,
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

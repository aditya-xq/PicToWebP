//! Resolution of the conversion output folder.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Resolve where converted files should be written.
///
/// * `--out` wins when supplied. It must be missing or empty; an existing
///   non-empty folder is rejected instead of being merged into, so a run can
///   never overwrite unrelated files.
/// * A single-file run without `--out` writes the `.webp` next to the source.
/// * A folder run without `--out` creates `<source>_webp_<unix-seconds>`.
/// * A dry run never creates anything and returns `None` when the final folder
///   name cannot be known ahead of time.
pub fn resolve_output_folder(
    source_root: &Path,
    requested: Option<&Path>,
    single_file: bool,
    dry_run: bool,
) -> anyhow::Result<Option<PathBuf>> {
    if let Some(out) = requested {
        if !single_file && is_inside(out, source_root) {
            anyhow::bail!(
                "Output folder must not be inside the source folder: {}",
                out.display()
            );
        }
        if out.exists() {
            if !out.is_dir() {
                anyhow::bail!("Output path is not a folder: {}", out.display());
            }
            if fs::read_dir(out)?.next().is_some() {
                anyhow::bail!(
                    "Output folder is not empty: {}. Choose a new folder or remove its contents.",
                    out.display()
                );
            }
        } else if !dry_run {
            fs::create_dir_all(out)?;
        }
        return Ok(Some(out.to_path_buf()));
    }

    if single_file {
        // Written next to the source image, e.g. `photo.png` -> `photo.webp`.
        return Ok(Some(source_root.to_path_buf()));
    }

    if dry_run {
        // The timestamped name is allocated at conversion time.
        return Ok(None);
    }

    create_sibling_folder(source_root).map(Some)
}

/// Create the output folder next to the source folder.
///
/// The folder is named `<source>_webp_<unix-seconds>` so repeated runs never
/// clash. If it already exists, a numeric suffix is tried.
fn create_sibling_folder(source_folder: &Path) -> anyhow::Result<PathBuf> {
    let folder_name = source_folder.file_name().unwrap_or(OsStr::new("images"));
    let parent = source_folder.parent().unwrap_or(source_folder);

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    for suffix in 0..10_000 {
        let mut name = folder_name.to_os_string();
        name.push(format!("_webp_{seconds}"));
        if suffix > 0 {
            name.push(format!("_{suffix}"));
        }
        let output_folder = parent.join(name);
        match fs::create_dir(&output_folder) {
            Ok(()) => return Ok(output_folder),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    anyhow::bail!("Could not allocate a unique output folder")
}

/// True when `candidate` is the same as, or nested under, `root`.
pub fn is_inside(candidate: &Path, root: &Path) -> bool {
    let candidate = components(&lexical(&absolute(candidate)));
    let root = components(&lexical(&absolute(root)));
    candidate.len() >= root.len() && candidate[..root.len()] == root[..]
}

/// Resolve `.` and `..` without touching the filesystem, so a non-existent
/// `--out` cannot escape the source-folder check on platforms where
/// `std::path::absolute` leaves `..` in place.
fn lexical(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let text = component.as_os_str().to_string_lossy();
            // Windows and default macOS filesystems are case-insensitive.
            if cfg!(windows) || cfg!(target_os = "macos") {
                text.to_lowercase()
            } else {
                text.into_owned()
            }
        })
        .collect()
}

fn absolute(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return strip_verbatim(resolved);
    }
    // A non-existent destination can sit under an existing ancestor whose
    // short (8.3) spelling differs from its canonical long spelling. Resolve
    // the longest existing ancestor and append the remaining components.
    let mut current = path.to_path_buf();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    while let Some(name) = current.file_name().map(|name| name.to_os_string()) {
        suffix.push(name);
        let Some(parent) = current.parent() else {
            break;
        };
        if parent.as_os_str().is_empty() {
            break;
        }
        if let Ok(resolved) = parent.canonicalize() {
            let mut base = strip_verbatim(resolved);
            for part in suffix.iter().rev() {
                base.push(part);
            }
            return base;
        }
        current = parent.to_path_buf();
    }
    strip_verbatim(std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()))
}

/// `canonicalize` returns the Windows verbatim form (``\\?\C:\...``) while
/// `absolute` does not; strip it so both sides compare consistently.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "pictowebp-paths-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn creates_unique_sibling_folders() {
        let root = temp_root("unique");
        let source = root.join("photos");
        fs::create_dir_all(&source).unwrap();

        let first = resolve_output_folder(&source, None, false, false)
            .unwrap()
            .unwrap();
        let second = resolve_output_folder(&source, None, false, false)
            .unwrap()
            .unwrap();

        assert!(first.is_dir());
        assert!(second.is_dir());
        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(root.as_path()));
        assert!(
            first
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("photos_webp_")
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn falls_back_to_images_name_for_root_paths() {
        // A path with no file name component (e.g. "/") still resolves.
        let root = temp_root("root");
        let output = resolve_output_folder(&root, None, false, false)
            .unwrap()
            .unwrap();
        assert!(output.is_dir());
        fs::remove_dir_all(&output).ok();
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dry_run_does_not_create_a_folder() {
        let root = temp_root("dry");
        let source = root.join("photos");
        fs::create_dir_all(&source).unwrap();

        let output = resolve_output_folder(&source, None, false, true).unwrap();

        assert!(output.is_none());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1); // just `photos`

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn single_file_writes_next_to_the_source() {
        let root = temp_root("single");
        let output = resolve_output_folder(&root, None, true, false)
            .unwrap()
            .unwrap();
        assert_eq!(output, root);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn explicit_out_must_be_empty() {
        let root = temp_root("out");
        let source = root.join("photos");
        let out = root.join("dest");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("keep.txt"), b"x").unwrap();

        let error = resolve_output_folder(&source, Some(&out), false, false).unwrap_err();
        assert!(error.to_string().contains("not empty"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn explicit_out_inside_source_is_rejected() {
        let root = temp_root("inside");
        let source = root.join("photos");
        fs::create_dir_all(&source).unwrap();

        let error = resolve_output_folder(&source, Some(&source.join("converted")), false, false)
            .unwrap_err();
        assert!(error.to_string().contains("inside the source"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn parent_dir_escape_is_resolved_before_the_inside_check() {
        let root = temp_root("escape");
        let source = root.join("photos");
        fs::create_dir_all(&source).unwrap();

        // `photos/../photos/out` is inside the source even though the lexical
        // prefix does not look like it.
        let escaped = root.join("photos").join("..").join("photos").join("out");
        let error = resolve_output_folder(&source, Some(&escaped), false, false).unwrap_err();
        assert!(error.to_string().contains("inside the source"));

        fs::remove_dir_all(&root).ok();
    }
}

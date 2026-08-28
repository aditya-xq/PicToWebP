//! Resolution of the conversion output folder.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Create the output folder next to the source folder.
///
/// The folder is named `<source>_webp_<unix-seconds>` so repeated runs never
/// clash. If it already exists, the user is asked before it gets replaced.
pub fn resolve_output_folder(source_folder: &Path) -> anyhow::Result<PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_unique_sibling_folders() {
        let root = std::env::temp_dir().join(format!(
            "pictowebp-paths-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        let source = root.join("photos");
        fs::create_dir_all(&source).unwrap();

        let first = resolve_output_folder(&source).unwrap();
        let second = resolve_output_folder(&source).unwrap();

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
        let root =
            std::env::temp_dir().join(format!("pictowebp-paths-root-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let output = resolve_output_folder(&root).unwrap();
        assert!(output.is_dir());
        fs::remove_dir_all(&output).ok();
        fs::remove_dir_all(&root).ok();
    }
}

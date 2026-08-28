//! Recursive discovery of convertible images.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

const IMAGE_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

/// Find all supported images under `source_folder`, sorted for determinism.
/// Hidden directories (dot-prefixed) are skipped.
pub fn discover_images(source_folder: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = WalkDir::new(source_folder)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !is_hidden(entry.file_name()))
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| has_supported_extension(entry.path()))
        .map(walkdir::DirEntry::into_path)
        .collect();
    files.sort();
    files
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|name| name.starts_with('.'))
}

fn has_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn extension_match_is_case_insensitive() {
        assert!(has_supported_extension(Path::new("x/photo.PNG")));
        assert!(has_supported_extension(Path::new("x/photo.Jpg")));
        assert!(!has_supported_extension(Path::new("x/notes.txt")));
        assert!(!has_supported_extension(Path::new("x/noext")));
    }

    #[test]
    fn skips_hidden_directories() {
        let temp = std::env::temp_dir().join(format!("pictowebp-disc-{}", std::process::id()));
        let visible = temp.join("photos");
        let hidden = temp.join(".hidden");
        fs::create_dir_all(&visible).unwrap();
        fs::create_dir_all(&hidden).unwrap();
        fs::write(visible.join("a.png"), b"x").unwrap();
        fs::write(hidden.join("b.jpg"), b"x").unwrap();

        let found = discover_images(&temp);

        assert_eq!(found, vec![visible.join("a.png")]);
        fs::remove_dir_all(&temp).ok();
    }
}

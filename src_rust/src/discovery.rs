//! Recursive discovery of convertible images.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

const IMAGE_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

/// Find all supported images under `source_folder`, sorted for determinism.
pub fn discover_images(source_folder: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = WalkDir::new(source_folder)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| has_supported_extension(entry.path()))
        .map(walkdir::DirEntry::into_path)
        .collect();
    files.sort();
    files
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

    #[test]
    fn extension_match_is_case_insensitive() {
        assert!(has_supported_extension(Path::new("x/photo.PNG")));
        assert!(has_supported_extension(Path::new("x/photo.Jpg")));
        assert!(!has_supported_extension(Path::new("x/notes.txt")));
        assert!(!has_supported_extension(Path::new("x/noext")));
    }
}

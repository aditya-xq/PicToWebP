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

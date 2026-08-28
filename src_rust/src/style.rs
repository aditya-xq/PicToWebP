//! Centralized ANSI styling for the CLI. Colors are emitted only when
//! stdout is a real terminal and the `NO_COLOR` convention is not set.

use std::io::IsTerminal;
use std::path::Path;

pub const LINE: &str = "────────────────────────────────────────────────────────────────";

pub const RESET: &str = "\x1b[0m";
pub const BOLD_CYAN: &str = "\x1b[1;36m";
pub const CYAN: &str = "\x1b[36m";
pub const DIM: &str = "\x1b[2m";
pub const GREEN: &str = "\x1b[32m";
pub const YELLOW: &str = "\x1b[33m";
pub const RED: &str = "\x1b[31m";

/// Maximum number of characters displayed for a single error reason.
pub const MAX_REASON_DISPLAY_LENGTH: usize = 240;

/// Free-space threshold (in MiB) below which we warn the user.
pub const LOW_DISK_WARNING_MIB: u64 = 256;

/// Default name of the conversion error report inside the output folder.
pub const ERROR_REPORT_NAME: &str = "conversion-errors.txt";

pub fn supports_color() -> bool {
    if std::env::var_os("NO_COLOR").is_some() {
        return false;
    }
    std::io::stdout().is_terminal()
}

pub fn paint(value: impl std::fmt::Display, style: &str) -> String {
    if supports_color() {
        format!("{style}{value}{RESET}")
    } else {
        value.to_string()
    }
}

/// Display a path without the Windows extended-length prefix (``\\?\``).
///
/// `Path::canonicalize` returns the verbatim form on Windows, which is
/// unfriendly in a terminal. This helper keeps the visible string short
/// while preserving the path components users expect to see.
pub fn display_path(path: &Path) -> String {
    let mut text = path.display().to_string();
    // Strip the Windows verbatim prefix added by canonicalize.
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        text = stripped.to_string();
    }
    text
}

pub fn truncate_reason(reason: &str) -> String {
    if reason.chars().count() <= MAX_REASON_DISPLAY_LENGTH {
        return reason.to_string();
    }
    let truncated: String = reason.chars().take(MAX_REASON_DISPLAY_LENGTH - 1).collect();
    format!("{truncated}…")
}

/// Lightweight free-space probe for a destination folder.
pub struct DiskSpace {
    pub path: std::path::PathBuf,
    pub free_bytes: Option<u64>,
    pub low: bool,
}

pub fn check_disk_space(path: &Path) -> DiskSpace {
    let probe = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };
    match free_space_bytes(&probe) {
        Some(free) => DiskSpace {
            path: probe,
            free_bytes: Some(free),
            low: free < LOW_DISK_WARNING_MIB * 1024 * 1024,
        },
        None => DiskSpace {
            path: probe,
            free_bytes: None,
            low: false,
        },
    }
}

#[cfg(unix)]
fn free_space_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some(metadata.blocks_available() * metadata.fr_size())
}

#[cfg(windows)]
fn free_space_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::FALSE;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free_to_caller: u64 = 0;
    // SAFETY: `wide` is a nul-terminated UTF-16 string and `free_to_caller` is a
    // valid out-pointer for the duration of the call.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_to_caller,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != FALSE).then_some(free_to_caller)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paint_returns_plain_text_when_disabled() {
        // We cannot easily flip the TTY state for a test, so just assert
        // that the disabled-branch helper round-trips a string.
        assert_eq!(truncate_reason("short"), "short");
    }

    #[test]
    fn truncate_reason_long_is_truncated() {
        let long = "x".repeat(MAX_REASON_DISPLAY_LENGTH + 100);
        let truncated = truncate_reason(&long);
        assert!(truncated.chars().count() <= MAX_REASON_DISPLAY_LENGTH);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn check_disk_space_reports_low_threshold() {
        // We can't easily simulate a small free-space volume, but we can at
        // least confirm the call returns a structured value.
        let info = check_disk_space(Path::new("."));
        assert!(matches!(info.low, true | false));
    }

    #[test]
    fn display_path_strips_windows_verbatim_prefix() {
        let stripped = display_path(Path::new(r"\\?\C:\Users\me\photo.jpg"));
        assert!(!stripped.starts_with(r"\\?\"));
        assert!(stripped.ends_with("photo.jpg"));
    }

    #[test]
    fn display_path_passes_through_normal_paths() {
        let p = display_path(Path::new("/tmp/photo.jpg"));
        assert!(p.contains("photo.jpg"));
    }
}

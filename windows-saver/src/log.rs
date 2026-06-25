//! Minimal file logger for field diagnosis. A `.scr` is a GUI-subsystem app
//! with no console, so when something fails on a user's machine there's nothing
//! to see. This writes a few lines to `%TEMP%\Noctura.log` per run (mode,
//! graphics-device path, and — critically — any shader-compile error text from
//! D3DCompile), turning an unreproducible "it just doesn't launch" into a
//! one-file diagnosis.

use std::io::Write;

fn log_path() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push("Noctura.log");
    p
}

/// Truncate the log at process start so it only ever holds the latest run.
pub fn reset() {
    let _ = std::fs::File::create(log_path());
}

/// Append one line.
pub fn line(msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(f, "{msg}");
    }
}

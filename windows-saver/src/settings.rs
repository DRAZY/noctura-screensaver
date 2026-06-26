//! Persisted settings shared between the live saver, the preview pane, and the
//! config dialog. Mirrors the macOS `AuroraPreferences` (Preferences.swift):
//! same scenes, same 13 palettes, same control ranges and defaults. Stored in
//! the Windows registry under HKEY_CURRENT_USER\Software\Noctura.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
};

/// 16 scenes, in the shader's `u.scene` dispatch order.
pub const SCENES: [&str; 16] = [
    "Aurora Drift", "Northern Lights", "Deep Space", "Particle Drift", "Plasma Field",
    "Matrix Rain", "Fireflies", "Black Hole", "Hyperspace Tunnel", "Synthwave",
    "Kaleidoscope", "Caustics", "Polar Clock", "Liquid Chrome", "Nebula Drift",
    "Fractal Bloom",
];

/// A three-stop color palette the scenes blend between.
pub struct Palette {
    pub name: &'static str,
    pub a: [f32; 3],
    pub b: [f32; 3],
    pub c: [f32; 3],
}

/// 13 palettes, identical RGB stops to the macOS build.
pub const PALETTES: [Palette; 13] = [
    Palette { name: "Aurora",     a: [0.102, 0.071, 0.251], b: [0.784, 0.118, 0.541], c: [0.961, 0.651, 0.137] },
    Palette { name: "Borealis",   a: [0.020, 0.090, 0.130], b: [0.075, 0.760, 0.520], c: [0.620, 0.950, 0.420] },
    Palette { name: "Deep Space", a: [0.008, 0.012, 0.039], b: [0.227, 0.184, 0.561], c: [0.812, 0.878, 1.000] },
    Palette { name: "Ocean",      a: [0.012, 0.055, 0.180], b: [0.047, 0.361, 0.639], c: [0.420, 0.824, 0.878] },
    Palette { name: "Ember",      a: [0.110, 0.020, 0.012], b: [0.780, 0.231, 0.039], c: [0.980, 0.816, 0.263] },
    Palette { name: "Synthwave",  a: [0.090, 0.008, 0.188], b: [0.851, 0.110, 0.561], c: [0.180, 0.760, 0.922] },
    Palette { name: "Sunset",     a: [0.141, 0.063, 0.137], b: [0.910, 0.353, 0.420], c: [1.000, 0.808, 0.420] },
    Palette { name: "Nebula",     a: [0.039, 0.016, 0.094], b: [0.482, 0.184, 0.969], c: [0.969, 0.435, 0.831] },
    Palette { name: "Mint",       a: [0.016, 0.078, 0.059], b: [0.122, 0.722, 0.573], c: [0.788, 1.000, 0.910] },
    Palette { name: "Gold",       a: [0.078, 0.051, 0.008], b: [0.690, 0.490, 0.102], c: [1.000, 0.914, 0.659] },
    Palette { name: "Ice",        a: [0.016, 0.039, 0.078], b: [0.231, 0.435, 0.682], c: [0.914, 0.965, 1.000] },
    Palette { name: "Rose",       a: [0.110, 0.024, 0.063], b: [0.839, 0.200, 0.424], c: [1.000, 0.851, 0.761] },
    Palette { name: "Monochrome", a: [0.020, 0.020, 0.025], b: [0.380, 0.400, 0.440], c: [0.918, 0.937, 0.961] },
];

/// Performance profile: a render-resolution scale ceiling and a frame interval.
pub struct Performance {
    pub name: &'static str,
    pub max_scale: f32,
    pub frame_secs: f32,
    pub is_auto: bool,
}

pub const PERFORMANCE: [Performance; 4] = [
    Performance { name: "Auto (adaptive)",      max_scale: 1.0,        frame_secs: 1.0 / 60.0, is_auto: true },
    Performance { name: "Full (60 fps)",        max_scale: 1.0,        frame_secs: 1.0 / 60.0, is_auto: false },
    Performance { name: "Balanced (60 fps)",    max_scale: 1.0 / 1.5,  frame_secs: 1.0 / 60.0, is_auto: false },
    Performance { name: "Power Saver (30 fps)", max_scale: 1.0 / 2.0,  frame_secs: 1.0 / 30.0, is_auto: false },
];

/// Clock overlay options (parity with the macOS saver and the WebGL app).
pub const CLOCK_MODES: [&str; 3] = ["Off", "Time", "Time + Date"];
pub const CLOCK_FONTS: [&str; 4] = ["Light", "Modern", "Bold", "Mono"];
pub const CLOCK_POSITIONS: [&str; 4] = ["Center", "Top", "Bottom", "Corner"];

/// Control ranges, matching the macOS sliders.
pub const SPEED_RANGE: (f32, f32) = (0.03, 1.2);
pub const INTENSITY_RANGE: (f32, f32) = (0.0, 1.5);
pub const DENSITY_RANGE: (f32, f32) = (0.0, 1.0);
pub const SIZE_RANGE: (f32, f32) = (0.4, 2.2);

#[derive(Clone, Copy)]
pub struct Settings {
    pub scene: usize,
    pub palette: usize,
    pub speed: f32,
    pub intensity: f32,
    pub density: f32,
    pub size: f32,
    pub performance: usize,
    pub clock_mode: usize,
    pub clock_font: usize,
    pub clock_pos: usize,
    pub clock_24h: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            scene: 0, palette: 0, speed: 0.3, intensity: 1.0,
            density: 0.5, size: 0.85, performance: 0,
            clock_mode: 0, clock_font: 1, clock_pos: 2, clock_24h: false,
        }
    }
}

fn clampf(v: f32, r: (f32, f32)) -> f32 { v.max(r.0).min(r.1) }
fn clampi(v: i64, lo: i64, hi: i64) -> i64 { v.max(lo).min(hi) }

impl Settings {
    pub fn palette(&self) -> &'static Palette { &PALETTES[self.palette.min(PALETTES.len() - 1)] }
    pub fn perf(&self) -> &'static Performance { &PERFORMANCE[self.performance.min(PERFORMANCE.len() - 1)] }

    /// Load from HKCU\Software\Noctura, falling back to defaults for any
    /// missing/invalid value. Values are stored as REG_SZ strings so the same
    /// keys are trivially inspectable in regedit.
    pub fn load() -> Settings {
        let mut s = Settings::default();
        if let Some(v) = read_str("sceneIndex") { if let Ok(n) = v.parse::<i64>() { s.scene = clampi(n, 0, 15) as usize; } }
        if let Some(v) = read_str("paletteIndex") { if let Ok(n) = v.parse::<i64>() { s.palette = clampi(n, 0, 12) as usize; } }
        if let Some(v) = read_str("performanceIndex") { if let Ok(n) = v.parse::<i64>() { s.performance = clampi(n, 0, 3) as usize; } }
        if let Some(v) = read_str("speed") { if let Ok(f) = v.parse::<f32>() { s.speed = clampf(f, SPEED_RANGE); } }
        if let Some(v) = read_str("intensity") { if let Ok(f) = v.parse::<f32>() { s.intensity = clampf(f, INTENSITY_RANGE); } }
        if let Some(v) = read_str("density") { if let Ok(f) = v.parse::<f32>() { s.density = clampf(f, DENSITY_RANGE); } }
        if let Some(v) = read_str("size") { if let Ok(f) = v.parse::<f32>() { s.size = clampf(f, SIZE_RANGE); } }
        if let Some(v) = read_str("clockMode") { if let Ok(n) = v.parse::<i64>() { s.clock_mode = clampi(n, 0, 2) as usize; } }
        if let Some(v) = read_str("clockFont") { if let Ok(n) = v.parse::<i64>() { s.clock_font = clampi(n, 0, 3) as usize; } }
        if let Some(v) = read_str("clockPosition") { if let Ok(n) = v.parse::<i64>() { s.clock_pos = clampi(n, 0, 3) as usize; } }
        if let Some(v) = read_str("clock24h") { s.clock_24h = v == "1"; }
        s
    }

    /// Persist all fields to HKCU\Software\Noctura.
    pub fn save(&self) {
        write_str("sceneIndex", &self.scene.to_string());
        write_str("paletteIndex", &self.palette.to_string());
        write_str("performanceIndex", &self.performance.to_string());
        write_str("speed", &format!("{}", self.speed));
        write_str("intensity", &format!("{}", self.intensity));
        write_str("density", &format!("{}", self.density));
        write_str("size", &format!("{}", self.size));
        write_str("clockMode", &self.clock_mode.to_string());
        write_str("clockFont", &self.clock_font.to_string());
        write_str("clockPosition", &self.clock_pos.to_string());
        write_str("clock24h", if self.clock_24h { "1" } else { "0" });
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn read_str(name: &str) -> Option<String> {
    let name_w = to_wide(name);
    let mut buf = [0u16; 256];
    let mut size: u32 = (buf.len() * 2) as u32;
    unsafe {
        let r = RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Noctura"),
            PCWSTR(name_w.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        );
        if r != ERROR_SUCCESS {
            return None;
        }
    }
    // RegGetValueW reports size in bytes including the trailing NUL when one is
    // present; only strip it if it's actually there (hand-edited values may not
    // be NUL-terminated, and dropping a real char would corrupt the value).
    let count = (size as usize / 2).min(buf.len());
    let len = if count > 0 && buf[count - 1] == 0 { count - 1 } else { count };
    Some(String::from_utf16_lossy(&buf[..len]))
}

fn write_str(name: &str, value: &str) {
    let name_w = to_wide(name);
    let value_w = to_wide(value);
    unsafe {
        let mut hkey = HKEY::default();
        let r = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            w!("Software\\Noctura"),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_READ | KEY_WRITE,
            None,
            &mut hkey,
            None,
        );
        if r != ERROR_SUCCESS {
            return;
        }
        let bytes = std::slice::from_raw_parts(value_w.as_ptr() as *const u8, value_w.len() * 2);
        let _ = RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), 0, REG_SZ, Some(bytes));
        let _ = RegCloseKey(hkey);
    }
}

//! Noctura — a native Windows screensaver (`.scr`).
//!
//! A `.scr` is an ordinary PE executable that Windows launches with one of:
//!   /s            run full-screen (the actual screensaver)
//!   /p <hwnd>     render a live preview into the Settings mini-pane
//!   /c[:<hwnd>]   show the configuration dialog
//! (no args)       also treated as configure, for double-click in Explorer.
//!
//! Rendering is native Direct3D 11 (see `gfx`), running the exact same 13
//! scenes / 13 palettes as the macOS saver and the WebGL gallery, for full
//! cross-platform parity with zero runtime dependencies (D3D11 ships on every
//! supported Windows; nothing to install).

#![windows_subsystem = "windows"]

mod config;
mod gfx;
mod log;
mod settings;

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, Instant};

use gfx::{ClockDraw, Gfx, Surface, Uniforms};
use settings::Settings;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, POINT, RECT, TRUE, WPARAM};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::UI::WindowsAndMessaging::*;

static QUIT: AtomicBool = AtomicBool::new(false);
static IS_PREVIEW: AtomicBool = AtomicBool::new(false);
/// Packed first mouse position (x in low 32, y in high 32); i64::MIN = unset.
static MOUSE_BASE: AtomicI64 = AtomicI64::new(i64::MIN);

/// Longest back-buffer edge we will ever render, protecting 6K/8K/spanned
/// displays in every performance mode (matches the macOS hard backstop).
const MAX_EDGE: u32 = 5120;
/// Pixels of cursor travel before we treat it as "user is back" and exit.
const MOUSE_EXIT_THRESHOLD: i32 = 12;
/// On battery we clamp the render scale to at most this fraction of the window
/// and the frame rate to `POWER_SAVE_MAX_FPS`, on top of the user's chosen mode —
/// a screensaver must not drain a laptop. Windows' render scale is
/// window-relative (1.0 = native), so unlike the DPR-relative web/macOS engines a
/// cap of 1.0 wouldn't bite; 0.75 meaningfully cuts the fragment count while
/// staying crisp under upscale.
const POWER_SAVE_MAX_SCALE: f32 = 0.75;
const POWER_SAVE_MAX_FPS: f32 = 30.0;

enum Mode {
    Saver,
    Preview(isize),
    Config(Option<isize>),
}

fn main() {
    log::reset();
    let argv: Vec<String> = std::env::args().collect();
    log::line(&format!("start argv={argv:?}"));
    let args: Vec<String> = argv.iter().skip(1).cloned().collect();
    let mode = parse_mode(&args);
    let result = match mode {
        Mode::Config(owner) => {
            log::line(&format!("mode=config owner={owner:?}"));
            config::show_config(owner);
            Ok(())
        }
        Mode::Preview(hwnd) => {
            log::line(&format!("mode=preview hwnd={hwnd}"));
            run_preview(HWND(hwnd as *mut _))
        }
        Mode::Saver => {
            log::line("mode=saver");
            run_saver()
        }
    };
    // A failed graphics init should never hang a screensaver — just exit.
    if let Err(e) = &result {
        log::line(&format!("exited with error: {e:?}"));
    } else {
        log::line("exited ok");
    }
    let _ = result;
}

/// Parse the screensaver command-line flags. Accepts `/`- or `-`-prefixed
/// flags, with the preview/config HWND either inline (`/p:1234`) or as the
/// following argument (`/p 1234`).
fn parse_mode(args: &[String]) -> Mode {
    if args.is_empty() {
        return Mode::Config(None);
    }
    let first = args[0].trim();
    let stripped = first.trim_start_matches(['/', '-']).to_ascii_lowercase();
    let flag = stripped.chars().next().unwrap_or('c');
    // Value after an inline ':' or '=', else the next argument. Windows passes
    // a window handle either inline (`/p:1234`, `/c:1234`) or as a separate
    // token (`/p 1234`).
    let inline: Option<&str> = stripped
        .split_once(['=', ':'])
        .map(|(_, v)| v)
        .filter(|v| !v.is_empty());
    let hwnd_val = || -> Option<isize> {
        inline
            .and_then(|v| v.parse::<isize>().ok())
            .or_else(|| args.get(1).and_then(|v| v.trim().parse::<isize>().ok()))
    };
    match flag {
        's' => Mode::Saver,
        'p' => match hwnd_val() {
            Some(h) => Mode::Preview(h),
            None => Mode::Config(None),
        },
        // 'c' configure (optionally owned by the passed Settings HWND); 'a'
        // (password change) and anything unexpected fall back to configure.
        _ => Mode::Config(hwnd_val()),
    }
}

/// Local-time fractions the Polar Clock scene consumes.
fn clock_values() -> ([f32; 4], f32) {
    let st = unsafe { GetLocalTime() };
    let sec = (st.wSecond as f32 + st.wMilliseconds as f32 / 1000.0) / 60.0;
    let min = (st.wMinute as f32 + sec) / 60.0;
    let hour = ((st.wHour % 12) as f32 + min) / 12.0;
    let day = (st.wHour as f32 * 3600.0 + st.wMinute as f32 * 60.0 + st.wSecond as f32) / 86400.0;
    let month = ((st.wMonth as f32 - 1.0) + (st.wDay as f32 - 1.0) / 31.0) / 12.0;
    ([sec, min, hour, day], month)
}

/// Format the clock's time line (and optional date line) from the local clock,
/// honoring the 12/24-hour setting. Returns `(time, Some(date))` when the mode
/// is Time + Date, else `(time, None)`.
fn clock_strings(s: &Settings) -> (String, Option<String>) {
    let st = unsafe { GetLocalTime() };
    let (h, m) = (st.wHour, st.wMinute);
    let time = if s.clock_24h {
        format!("{:02}:{:02}", h, m)
    } else {
        let h12 = match h % 12 {
            0 => 12,
            x => x,
        };
        format!("{}:{:02} {}", h12, m, if h < 12 { "AM" } else { "PM" })
    };
    let date = if s.clock_mode == 2 {
        const WD: [&str; 7] = [
            "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
        ];
        const MO: [&str; 12] = [
            "January", "February", "March", "April", "May", "June", "July", "August",
            "September", "October", "November", "December",
        ];
        let wd = WD[(st.wDayOfWeek as usize) % 7];
        let mo = MO[(st.wMonth as usize).saturating_sub(1) % 12];
        Some(format!("{}, {} {}", wd, mo, st.wDay))
    } else {
        None
    };
    (time, date)
}

fn build_uniforms(s: &Settings, time: f32, res: [f32; 2]) -> Uniforms {
    let p = s.palette();
    let (clock, month) = clock_values();
    Uniforms {
        time,
        speed: s.speed,
        intensity: s.intensity,
        density: s.density,
        scene: s.scene as f32,
        month,
        ticks: 1.0,
        size: s.size,
        resolution: res,
        pad1: [0.0, 0.0],
        color_a: [p.a[0], p.a[1], p.a[2], 1.0],
        color_b: [p.b[0], p.b[1], p.b[2], 1.0],
        color_c: [p.c[0], p.c[1], p.c[2], 1.0],
        clock,
    }
}

/// Convert a window pixel size to a back-buffer size under the active
/// performance scale, clamped to the MAX_EDGE backstop.
fn backbuffer_size(win_w: i32, win_h: i32, scale: f32) -> (u32, u32) {
    let s = scale.clamp(0.1, 1.0);
    let mut w = ((win_w.max(1) as f32) * s).round() as u32;
    let mut h = ((win_h.max(1) as f32) * s).round() as u32;
    let longest = w.max(h);
    if longest > MAX_EDGE {
        let k = MAX_EDGE as f32 / longest as f32;
        w = ((w as f32) * k) as u32;
        h = ((h as f32) * k) as u32;
    }
    (w.max(1), h.max(1))
}

/// Whether the machine is currently running on battery. `ACLineStatus` is 0 when
/// offline (battery), 1 when online (AC), 255 unknown — only a definite 0 counts
/// as battery, so desktops and unknown states keep full quality.
fn on_battery() -> bool {
    unsafe {
        let mut status = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut status).is_ok() {
            status.ACLineStatus == 0
        } else {
            false
        }
    }
}

/// Fold the battery clamp into a base `(scale, frame_secs)`: on battery the scale
/// is capped to `POWER_SAVE_MAX_SCALE` and the frame interval floored to 30 fps;
/// on AC both pass through untouched.
fn effective_profile(base_scale: f32, base_frame: f32, on_batt: bool) -> (f32, Duration) {
    if on_batt {
        (
            base_scale.min(POWER_SAVE_MAX_SCALE),
            Duration::from_secs_f32(base_frame.max(1.0 / POWER_SAVE_MAX_FPS)),
        )
    } else {
        (base_scale, Duration::from_secs_f32(base_frame))
    }
}

/// (Re)build one render surface per screensaver window at the given render scale.
/// Used both at startup and when the power source flips mid-run and the scale
/// changes (old surfaces drop, new ones are created against the same HWNDs).
fn build_surfaces(gfx: &Gfx, wins: &[(HWND, i32, i32)], scale: f32) -> Vec<Surface> {
    let mut surfaces = Vec::with_capacity(wins.len());
    for &(hwnd, w, h) in wins {
        let (bw, bh) = backbuffer_size(w, h, scale);
        if let Ok(surf) = gfx.create_surface(hwnd, bw, bh) {
            surfaces.push(surf);
        }
    }
    surfaces
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_MOUSEMOVE if !IS_PREVIEW.load(Ordering::Relaxed) => {
            // Compare in SCREEN coordinates: the message LPARAM is per-window
            // client space, so on multi-monitor a move on a second display would
            // read as a huge delta against the first display's baseline and
            // dismiss instantly. GetCursorPos is global and avoids that.
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let (x, y) = (pt.x, pt.y);
            let packed = ((x as i64) & 0xffff_ffff) | ((y as i64) << 32);
            let base = MOUSE_BASE.load(Ordering::Relaxed);
            if base == i64::MIN {
                MOUSE_BASE.store(packed, Ordering::Relaxed);
            } else {
                let bx = (base & 0xffff_ffff) as i32;
                let by = (base >> 32) as i32;
                if (x - bx).abs() > MOUSE_EXIT_THRESHOLD || (y - by).abs() > MOUSE_EXIT_THRESHOLD {
                    QUIT.store(true, Ordering::Relaxed);
                }
            }
            LRESULT(0)
        }
        WM_KEYDOWN | WM_SYSKEYDOWN | WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN
            if !IS_PREVIEW.load(Ordering::Relaxed) =>
        {
            QUIT.store(true, Ordering::Relaxed);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

unsafe extern "system" fn monitor_proc(
    _h: HMONITOR,
    _hdc: HDC,
    rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let v = &mut *(data.0 as *mut Vec<RECT>);
    v.push(*rect);
    TRUE
}

fn register_class(class: PCWSTR) {
    unsafe {
        let hinstance = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance.into(),
            lpszClassName: class,
            hCursor: HCURSOR::default(),
            ..Default::default()
        };
        RegisterClassW(&wc);
    }
}

fn run_saver() -> windows::core::Result<()> {
    let settings = Settings::load();
    let perf = settings.perf();
    let base_scale = if perf.is_auto { 1.0 } else { perf.max_scale };
    let base_frame = perf.frame_secs;
    // Fold in the battery clamp up front so a saver that starts while unplugged
    // is already light; the loop re-checks and adjusts live if power flips.
    let mut on_batt = on_battery();
    let (mut scale, mut target_frame) = effective_profile(base_scale, base_frame, on_batt);

    let class = w!("NocturaSaverWindow");
    register_class(class);

    // One full-screen, top-most, borderless window per monitor.
    let mut rects: Vec<RECT> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_proc),
            LPARAM(&mut rects as *mut _ as isize),
        );
    }
    if rects.is_empty() {
        unsafe {
            rects.push(RECT {
                left: 0,
                top: 0,
                right: GetSystemMetrics(SM_CXSCREEN),
                bottom: GetSystemMetrics(SM_CYSCREEN),
            });
        }
    }

    log::line(&format!("saver: {} monitor(s), scale={scale}", rects.len()));
    let gfx = match Gfx::new() {
        Ok(g) => g,
        Err(e) => {
            log::line(&format!("Gfx::new failed: {e:?}"));
            return Err(e);
        }
    };
    // Handles + pixel sizes of every screensaver window, kept so surfaces can be
    // rebuilt at a new render scale if the power source flips mid-run.
    let mut windows_hw: Vec<(HWND, i32, i32)> = Vec::new();
    let mut first_hwnd: Option<HWND> = None;
    unsafe {
        let hinstance = GetModuleHandleW(None).unwrap_or_default();
        for r in &rects {
            let (w, h) = (r.right - r.left, r.bottom - r.top);
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST,
                class,
                w!("Noctura"),
                WS_POPUP | WS_VISIBLE,
                r.left,
                r.top,
                w,
                h,
                None,
                None,
                hinstance,
                None,
            )?;
            if first_hwnd.is_none() {
                first_hwnd = Some(hwnd);
            }
            windows_hw.push((hwnd, w, h));
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                r.left,
                r.top,
                w,
                h,
                SWP_SHOWWINDOW,
            );
        }
    }
    let mut surfaces = build_surfaces(&gfx, &windows_hw, scale);

    // Bail before touching the cursor so a failed init can't leave it hidden.
    log::line(&format!("saver: {} surface(s) created", surfaces.len()));
    if surfaces.is_empty() {
        log::line("saver: no surfaces — exiting (nothing to render)");
        return Ok(());
    }

    unsafe {
        // Take the foreground so key presses reach us (keyboard dismiss), and
        // hide the cursor for the duration of the saver.
        if let Some(h) = first_hwnd {
            let _ = SetForegroundWindow(h);
            let _ = BringWindowToTop(h);
        }
        while ShowCursor(false) >= 0 {}
    }

    let start = Instant::now();
    let mut last = Instant::now();
    let mut last_power = Instant::now();
    let mut msg = MSG::default();
    'outer: loop {
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    break 'outer;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if QUIT.load(Ordering::Relaxed) {
            break;
        }
        // Re-check the power source a couple of times a second (cheap syscall).
        // A flip adjusts frame pacing immediately; a scale change also rebuilds
        // the surfaces so resolution tracks power without restarting the saver.
        if last_power.elapsed() >= Duration::from_secs(2) {
            last_power = Instant::now();
            let ob = on_battery();
            if ob != on_batt {
                on_batt = ob;
                let (ns, nf) = effective_profile(base_scale, base_frame, ob);
                target_frame = nf;
                if (ns - scale).abs() > f32::EPSILON {
                    scale = ns;
                    surfaces = build_surfaces(&gfx, &windows_hw, scale);
                }
                log::line(&format!(
                    "power change: on_battery={ob} scale={scale} fps={:.0}",
                    1.0 / target_frame.as_secs_f32()
                ));
            }
        }
        let t = start.elapsed().as_secs_f32();
        let (ctime, cdate) = clock_strings(&settings);
        let clock = (settings.clock_mode != 0).then(|| ClockDraw {
            time: &ctime,
            date: cdate.as_deref(),
            font: settings.clock_font,
            pos: settings.clock_pos,
        });
        for surf in &surfaces {
            let u = build_uniforms(&settings, t, [surf.bb_w as f32, surf.bb_h as f32]);
            if !gfx.render(surf, &u, 1, clock.as_ref()) {
                // Device lost (TDR / driver reset). Don't sit on a frozen
                // frame — end the saver so the desktop returns.
                QUIT.store(true, Ordering::Relaxed);
            }
        }
        // Frame pacing (PowerSaver caps at 30 fps; others ride vsync at 60).
        let elapsed = last.elapsed();
        if elapsed < target_frame {
            std::thread::sleep(target_frame - elapsed);
        }
        last = Instant::now();
    }

    unsafe {
        while ShowCursor(true) < 0 {}
    }
    Ok(())
}

fn run_preview(parent: HWND) -> windows::core::Result<()> {
    IS_PREVIEW.store(true, Ordering::Relaxed);
    let settings = Settings::load();

    let class = w!("NocturaPreviewWindow");
    register_class(class);

    let mut rc = RECT::default();
    unsafe {
        let _ = GetClientRect(parent, &mut rc);
    }
    let (w, h) = ((rc.right - rc.left).max(1), (rc.bottom - rc.top).max(1));

    let gfx = match Gfx::new() {
        Ok(g) => g,
        Err(e) => {
            log::line(&format!("preview Gfx::new failed: {e:?}"));
            return Err(e);
        }
    };
    let child;
    unsafe {
        let hinstance = GetModuleHandleW(None).unwrap_or_default();
        child = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("Noctura"),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            w,
            h,
            parent,
            None,
            hinstance,
            None,
        )?;
    }
    // Preview is small; render at native size, lightly.
    let surf = gfx.create_surface(child, w as u32, h as u32)?;

    let start = Instant::now();
    let mut msg = MSG::default();
    'outer: loop {
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    break 'outer;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            // Stop cleanly once the Settings pane (parent) or our child window
            // is gone — never render/Present into a destroyed window.
            if !IsWindow(parent).as_bool() || !IsWindow(child).as_bool() {
                break;
            }
        }
        let t = start.elapsed().as_secs_f32();
        let u = build_uniforms(&settings, t, [surf.bb_w as f32, surf.bb_h as f32]);
        let (ctime, cdate) = clock_strings(&settings);
        let clock = (settings.clock_mode != 0).then(|| ClockDraw {
            time: &ctime,
            date: cdate.as_deref(),
            font: settings.clock_font,
            pos: settings.clock_pos,
        });
        gfx.render(&surf, &u, 1, clock.as_ref());
        std::thread::sleep(Duration::from_millis(16));
    }
    Ok(())
}

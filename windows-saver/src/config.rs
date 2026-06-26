//! Configuration dialog, built programmatically (no .rc resource, so it
//! cross-compiles cleanly). Exposes the same controls as the macOS Options
//! sheet — Scene, Style (palette), Speed, Intensity, Density, Size,
//! Performance — and writes them to HKCU\Software\Noctura via `settings`.

use std::ffi::c_void;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetSysColorBrush, COLOR_BTNFACE};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::{InitCommonControlsEx, ICC_BAR_CLASSES, INITCOMMONCONTROLSEX};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::settings::{
    Settings, CLOCK_FONTS, CLOCK_MODES, CLOCK_POSITIONS, DENSITY_RANGE, INTENSITY_RANGE, PALETTES,
    PERFORMANCE, SCENES, SIZE_RANGE, SPEED_RANGE,
};

// Win32 message numbers (stable; used as literals to avoid import-path churn).
const CB_ADDSTRING: u32 = 0x0143;
const CB_SETCURSEL: u32 = 0x014E;
const CB_GETCURSEL: u32 = 0x0147;
const TBM_SETRANGE: u32 = 0x0406;
const TBM_SETPOS: u32 = 0x0405;
const TBM_GETPOS: u32 = 0x0400;
const BM_GETCHECK: u32 = 0x00F0;
const BM_SETCHECK: u32 = 0x00F1;
const BS_AUTOCHECKBOX: u32 = 0x0003;

const ID_SCENE: usize = 1001;
const ID_PALETTE: usize = 1002;
const ID_PERF: usize = 1003;
const ID_CLOCK: usize = 1004;
const ID_CFONT: usize = 1005;
const ID_CPOS: usize = 1006;
const ID_C24: usize = 1007;
const ID_SPEED: usize = 1010;
const ID_INTENSITY: usize = 1011;
const ID_DENSITY: usize = 1012;
const ID_SIZE: usize = 1013;
const ID_SAVE: usize = 1020;
const ID_CANCEL: usize = 1021;

const TB_MAX: i32 = 1000;

struct ConfigState {
    scene: HWND,
    palette: HWND,
    perf: HWND,
    speed: HWND,
    intensity: HWND,
    density: HWND,
    size: HWND,
    clock: HWND,
    cfont: HWND,
    cpos: HWND,
    c24: HWND,
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn tb_to_f(pos: i32, range: (f32, f32)) -> f32 {
    range.0 + (pos.clamp(0, TB_MAX) as f32 / TB_MAX as f32) * (range.1 - range.0)
}
fn f_to_tb(v: f32, range: (f32, f32)) -> i32 {
    (((v - range.0) / (range.1 - range.0)) * TB_MAX as f32).round() as i32
}

unsafe fn send(hwnd: HWND, msg: u32, w: usize, l: isize) -> isize {
    SendMessageW(hwnd, msg, WPARAM(w), LPARAM(l)).0
}

unsafe fn make_label(parent: HWND, hinst: windows::Win32::Foundation::HINSTANCE, text: &str, x: i32, y: i32) {
    let t = to_wide(text);
    let _ = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("STATIC"),
        PCWSTR(t.as_ptr()),
        WS_CHILD | WS_VISIBLE,
        x,
        y,
        110,
        22,
        parent,
        HMENU::default(),
        hinst,
        None,
    );
}

unsafe fn make_combo(
    parent: HWND,
    hinst: windows::Win32::Foundation::HINSTANCE,
    id: usize,
    x: i32,
    y: i32,
    items: &[&str],
    sel: usize,
) -> HWND {
    let combo = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("COMBOBOX"),
        PCWSTR::null(),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL | WINDOW_STYLE(0x0003) | WINDOW_STYLE(0x0200),
        // 0x0003 = CBS_DROPDOWNLIST, 0x0200 = CBS_HASSTRINGS
        x,
        y,
        200,
        260,
        parent,
        HMENU(id as *mut c_void),
        hinst,
        None,
    )
    .unwrap_or_default();
    for it in items {
        let t = to_wide(it);
        send(combo, CB_ADDSTRING, 0, t.as_ptr() as isize);
    }
    send(combo, CB_SETCURSEL, sel, 0);
    combo
}

unsafe fn make_trackbar(
    parent: HWND,
    hinst: windows::Win32::Foundation::HINSTANCE,
    id: usize,
    x: i32,
    y: i32,
    pos: i32,
) -> HWND {
    let tb = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("msctls_trackbar32"),
        PCWSTR::null(),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        x,
        y,
        200,
        30,
        parent,
        HMENU(id as *mut c_void),
        hinst,
        None,
    )
    .unwrap_or_default();
    send(tb, TBM_SETRANGE, 1, (TB_MAX << 16) as isize);
    send(tb, TBM_SETPOS, 1, pos as isize);
    tb
}

unsafe fn make_button(
    parent: HWND,
    hinst: windows::Win32::Foundation::HINSTANCE,
    id: usize,
    text: &str,
    x: i32,
    y: i32,
) {
    let t = to_wide(text);
    let _ = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("BUTTON"),
        PCWSTR(t.as_ptr()),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        x,
        y,
        96,
        30,
        parent,
        HMENU(id as *mut c_void),
        hinst,
        None,
    );
}

unsafe fn make_checkbox(
    parent: HWND,
    hinst: windows::Win32::Foundation::HINSTANCE,
    id: usize,
    text: &str,
    x: i32,
    y: i32,
    checked: bool,
) -> HWND {
    let t = to_wide(text);
    let cb = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("BUTTON"),
        PCWSTR(t.as_ptr()),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(BS_AUTOCHECKBOX),
        x,
        y,
        200,
        24,
        parent,
        HMENU(id as *mut c_void),
        hinst,
        None,
    )
    .unwrap_or_default();
    send(cb, BM_SETCHECK, if checked { 1 } else { 0 }, 0);
    cb
}

unsafe extern "system" fn config_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = (wp.0 & 0xffff) as usize;
            if id == ID_SAVE {
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ConfigState;
                if !ptr.is_null() {
                    let st = &*ptr;
                    let mut s = Settings::load();
                    s.scene = send(st.scene, CB_GETCURSEL, 0, 0).max(0) as usize;
                    s.palette = send(st.palette, CB_GETCURSEL, 0, 0).max(0) as usize;
                    s.performance = send(st.perf, CB_GETCURSEL, 0, 0).max(0) as usize;
                    s.speed = tb_to_f(send(st.speed, TBM_GETPOS, 0, 0) as i32, SPEED_RANGE);
                    s.intensity = tb_to_f(send(st.intensity, TBM_GETPOS, 0, 0) as i32, INTENSITY_RANGE);
                    s.density = tb_to_f(send(st.density, TBM_GETPOS, 0, 0) as i32, DENSITY_RANGE);
                    s.size = tb_to_f(send(st.size, TBM_GETPOS, 0, 0) as i32, SIZE_RANGE);
                    s.clock_mode = send(st.clock, CB_GETCURSEL, 0, 0).max(0) as usize;
                    s.clock_font = send(st.cfont, CB_GETCURSEL, 0, 0).max(0) as usize;
                    s.clock_pos = send(st.cpos, CB_GETCURSEL, 0, 0).max(0) as usize;
                    s.clock_24h = send(st.c24, BM_GETCHECK, 0, 0) == 1;
                    s.save();
                }
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            } else if id == ID_CANCEL {
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            } else {
                DefWindowProcW(hwnd, msg, wp, lp)
            }
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ConfigState;
            if !ptr.is_null() {
                drop(Box::from_raw(ptr));
            }
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/// Show the configuration window and pump messages until closed. When Windows
/// passes an owner HWND (`/c:<hwnd>` from the Settings app), the dialog is
/// owned by it so it stays in front and closes with it.
pub fn show_config(owner: Option<isize>) {
    let s = Settings::load();
    let owner_hwnd = owner.map(|h| HWND(h as *mut c_void)).unwrap_or_default();
    unsafe {
        let icc = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: ICC_BAR_CLASSES,
        };
        let _ = InitCommonControlsEx(&icc);

        let hinst_mod = GetModuleHandleW(None).unwrap_or_default();
        let hinst = windows::Win32::Foundation::HINSTANCE(hinst_mod.0);
        let class = w!("NocturaConfigWindow");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(config_proc),
            hInstance: hinst,
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: GetSysColorBrush(COLOR_BTNFACE),
            ..Default::default()
        };
        RegisterClassW(&wc);

        let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
        let hwnd = match CreateWindowExW(
            WS_EX_CONTROLPARENT,
            class,
            w!("Noctura Screen Saver Settings"),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            380,
            508,
            owner_hwnd,
            HMENU::default(),
            hinst,
            None,
        ) {
            Ok(h) => h,
            Err(_) => return,
        };

        make_label(hwnd, hinst, "Scene", 20, 22);
        let scene = make_combo(hwnd, hinst, ID_SCENE, 150, 18, &SCENES, s.scene);
        make_label(hwnd, hinst, "Style", 20, 60);
        let palette_items: Vec<&str> = PALETTES.iter().map(|p| p.name).collect();
        let palette = make_combo(hwnd, hinst, ID_PALETTE, 150, 56, &palette_items, s.palette);

        make_label(hwnd, hinst, "Speed", 20, 100);
        let speed = make_trackbar(hwnd, hinst, ID_SPEED, 150, 96, f_to_tb(s.speed, SPEED_RANGE));
        make_label(hwnd, hinst, "Intensity", 20, 138);
        let intensity = make_trackbar(hwnd, hinst, ID_INTENSITY, 150, 134, f_to_tb(s.intensity, INTENSITY_RANGE));
        make_label(hwnd, hinst, "Density", 20, 176);
        let density = make_trackbar(hwnd, hinst, ID_DENSITY, 150, 172, f_to_tb(s.density, DENSITY_RANGE));
        make_label(hwnd, hinst, "Size", 20, 214);
        let size = make_trackbar(hwnd, hinst, ID_SIZE, 150, 210, f_to_tb(s.size, SIZE_RANGE));

        make_label(hwnd, hinst, "Performance", 20, 252);
        let perf_items: Vec<&str> = PERFORMANCE.iter().map(|p| p.name).collect();
        let perf = make_combo(hwnd, hinst, ID_PERF, 150, 248, &perf_items, s.performance);

        // Clock overlay controls (parity with macOS / the app).
        make_label(hwnd, hinst, "Clock", 20, 290);
        let clock = make_combo(hwnd, hinst, ID_CLOCK, 150, 286, &CLOCK_MODES, s.clock_mode);
        make_label(hwnd, hinst, "Font", 20, 328);
        let cfont = make_combo(hwnd, hinst, ID_CFONT, 150, 324, &CLOCK_FONTS, s.clock_font);
        make_label(hwnd, hinst, "Position", 20, 366);
        let cpos = make_combo(hwnd, hinst, ID_CPOS, 150, 362, &CLOCK_POSITIONS, s.clock_pos);
        let c24 = make_checkbox(hwnd, hinst, ID_C24, "24-hour clock", 150, 402, s.clock_24h);

        make_button(hwnd, hinst, ID_SAVE, "Save", 150, 446);
        make_button(hwnd, hinst, ID_CANCEL, "Cancel", 254, 446);

        let state = Box::new(ConfigState {
            scene, palette, perf, speed, intensity, density, size, clock, cfont, cpos, c24,
        });
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(state) as isize);

        let _ = ShowWindow(hwnd, SW_SHOW);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if !IsDialogMessageW(hwnd, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

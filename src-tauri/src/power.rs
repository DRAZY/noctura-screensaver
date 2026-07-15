//! Native power-source detection for the desktop shell.
//!
//! macOS WKWebView has no Battery Status API, so the web engine's battery clamp
//! (`SceneManager.setPowerSave`) never engages there without this seam. Mirrors
//! the `.saver`'s IOKit check: on battery OR macOS Low Power Mode → "battery".
//! Windows WebView2 already exposes `navigator.getBattery`, but the command
//! answers there too (GetSystemPowerStatus) so behavior is uniform.

/// Power source as seen by the OS: "battery", "ac", or "unknown".
#[tauri::command]
pub fn power_status() -> &'static str {
    match on_battery() {
        Some(true) => "battery",
        Some(false) => "ac",
        None => "unknown",
    }
}

#[cfg(target_os = "macos")]
fn on_battery() -> Option<bool> {
    use std::os::raw::c_void;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> *mut c_void; // CFTypeRef (owned)
        // Get rule — the returned CFStringRef is NOT owned by the caller.
        fn IOPSGetProvidingPowerSourceType(snapshot: *mut c_void) -> *mut c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(s: *mut c_void, buf: *mut u8, size: isize, encoding: u32) -> u8;
        fn CFRelease(p: *mut c_void);
    }
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    // NSProcessInfo.isLowPowerModeEnabled — Low Power Mode should clamp exactly
    // like battery, matching the .saver (AuroraView.refreshPowerSaveState).
    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const u8) -> *mut c_void;
        fn sel_registerName(name: *const u8) -> *mut c_void;
        fn objc_msgSend();
    }
    unsafe fn low_power_mode() -> bool {
        let cls = objc_getClass(b"NSProcessInfo\0".as_ptr());
        if cls.is_null() {
            return false;
        }
        let sel_info = sel_registerName(b"processInfo\0".as_ptr());
        let sel_lpm = sel_registerName(b"isLowPowerModeEnabled\0".as_ptr());
        let msg_obj: extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let msg_bool: extern "C" fn(*mut c_void, *mut c_void) -> u8 =
            std::mem::transmute(objc_msgSend as *const ());
        let info = msg_obj(cls, sel_info);
        if info.is_null() {
            return false;
        }
        msg_bool(info, sel_lpm) != 0
    }

    unsafe {
        if low_power_mode() {
            return Some(true);
        }
        let snap = IOPSCopyPowerSourcesInfo();
        if snap.is_null() {
            return None;
        }
        let ty = IOPSGetProvidingPowerSourceType(snap);
        let mut buf = [0u8; 64];
        let ok = !ty.is_null()
            && CFStringGetCString(ty, buf.as_mut_ptr(), buf.len() as isize, K_CF_STRING_ENCODING_UTF8)
                != 0;
        CFRelease(snap);
        if !ok {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let s = std::str::from_utf8(&buf[..end]).ok()?;
        // kIOPSBatteryPowerValue == "Battery Power"; AC is "AC Power".
        Some(s == "Battery Power")
    }
}

#[cfg(target_os = "windows")]
fn on_battery() -> Option<bool> {
    // SYSTEM_POWER_STATUS.ACLineStatus: 0 = offline (battery), 1 = online (AC),
    // 255 = unknown. Only a definite 0 counts as battery — same rule as the .scr.
    #[repr(C)]
    #[derive(Default)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }
    unsafe {
        let mut st = SystemPowerStatus::default();
        if GetSystemPowerStatus(&mut st) == 0 {
            return None;
        }
        match st.ac_line_status {
            0 => Some(true),
            1 => Some(false),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    // On real desktop hardware the probe must return a definite answer (a Mac or
    // PC always knows its power source); prints it for manual sanity-checking.
    #[test]
    fn probe_returns_definite_answer() {
        let status = super::power_status();
        println!("power_status() = {status}");
        assert!(status == "battery" || status == "ac");
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn on_battery() -> Option<bool> {
    // Linux: /sys/class/power_supply — first AC-type supply's online flag.
    let dir = std::fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in dir.flatten() {
        let p = entry.path();
        let ty = std::fs::read_to_string(p.join("type")).unwrap_or_default();
        if ty.trim() == "Mains" {
            let online = std::fs::read_to_string(p.join("online")).ok()?;
            return Some(online.trim() == "0");
        }
    }
    None
}

//! Window focus change detection for minibar mode.
//!
//! Uses `SetWinEventHook` with `EVENT_SYSTEM_FOREGROUND` to detect
//! when the user switches away from windowsMate - Thuki, triggering minibar mode.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::EVENT_SYSTEM_FOREGROUND;

/// WINEVENT_OUTOFCONTEXT = 0x0000 — hook callback is not in-context.
const WINEVENT_OUTOFCONTEXT: u32 = 0;

/// Whether the minibar mode is currently active.
static MINIBAR_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Set to true by screenshot commands while the main window is hidden for
/// capture. Prevents the focus-loss event from triggering minibar mode so the
/// window restores to its full state after the capture completes.
static SCREENSHOT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Set to true by the frontend while a native file picker dialog is open.
/// Prevents the focus-loss event from triggering minibar mode (which would
/// unmount the hidden <input type="file"> and swallow the onChange result).
static FILE_PICKER_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Suppresses or restores the minibar-on-focus-loss transition.
/// Call with `true` before hiding the window for a screenshot, `false` after
/// the window is shown again.
pub fn set_screenshot_in_progress(active: bool) {
    SCREENSHOT_IN_PROGRESS.store(active, Ordering::SeqCst);
}

/// Suppresses or restores the minibar-on-focus-loss transition while a native
/// file picker dialog is open. Call with `true` before opening the dialog,
/// `false` after the dialog closes (selection or cancel).
pub fn set_file_picker_in_progress(active: bool) {
    FILE_PICKER_IN_PROGRESS.store(active, Ordering::SeqCst);
}

/// Returns whether the minibar is currently active.
pub fn is_minibar_active() -> bool {
    MINIBAR_ACTIVE.load(Ordering::SeqCst)
}

/// Enters minibar mode — shrinks the overlay to a thin always-on-top strip.
pub fn enter_minibar() -> bool {
    MINIBAR_ACTIVE.store(true, Ordering::SeqCst);
    true
}

/// Exits minibar mode — restores the overlay to full size.
pub fn exit_minibar() -> bool {
    MINIBAR_ACTIVE.store(false, Ordering::SeqCst);
    false
}

/// Focus change callback type. Receives the HWND of the newly focused window.
type FocusChangeCallback = Arc<dyn Fn(HWND) + Send + Sync>;

/// Global state for the focus change hook.
static mut FOCUS_CALLBACK: Option<FocusChangeCallback> = None;
static mut FOCUS_HOOK: Option<HWINEVENTHOOK> = None;

/// HWND of the main windowsMate - Thuki window, used to filter self-focus events.
static mut MAIN_HWND: Option<HWND> = None;

/// Stores the main window HWND so the callback can filter self-focus events.
pub fn set_main_hwnd(hwnd: HWND) {
    unsafe {
        MAIN_HWND = Some(hwnd);
    }
}

/// The WinEvent hook callback.
#[allow(static_mut_refs)]
unsafe extern "system" fn focus_event_callback(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    // OBJID_WINDOW = 0
    if id_object != 0 {
        return;
    }

    // Skip if the focused window IS windowsMate - Thuki (user clicked back on us).
    if let Some(main_hwnd) = MAIN_HWND {
        if hwnd == main_hwnd {
            return;
        }
    }

    if let Some(callback) = FOCUS_CALLBACK.as_ref() {
        // Suppress focus-change events while a screenshot capture is in flight
        // so the window does not enter minibar mode when hidden for the capture.
        if SCREENSHOT_IN_PROGRESS.load(Ordering::SeqCst) {
            return;
        }
        // Suppress focus-change events while the native file picker is open
        // so the overlay DOM (including the hidden <input type="file">) stays
        // mounted and the onChange callback can fire after file selection.
        if FILE_PICKER_IN_PROGRESS.load(Ordering::SeqCst) {
            return;
        }
        callback(hwnd);
    }
}

/// Starts listening for window focus changes.
/// When a different window gets focus, the callback is invoked with that window's HWND.
#[allow(static_mut_refs)]
pub fn start_focus_listener(callback: FocusChangeCallback) -> Result<(), String> {
    unsafe {
        FOCUS_CALLBACK = Some(callback);

        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(focus_event_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );

        if hook.0.is_null() {
            return Err("SetWinEventHook returned null hook".to_string());
        }

        FOCUS_HOOK = Some(hook);
    }

    Ok(())
}

/// Stops the focus change listener.
#[allow(static_mut_refs)]
pub fn stop_focus_listener() -> Result<(), String> {
    unsafe {
        if let Some(hook) = FOCUS_HOOK.take() {
            let _ = UnhookWinEvent(hook);
        }
        FOCUS_CALLBACK = None;
    }
    Ok(())
}

// ─── Tauri commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn enter_minibar_command() -> Result<bool, String> {
    Ok(enter_minibar())
}

#[tauri::command]
pub fn exit_minibar_command() -> Result<bool, String> {
    Ok(exit_minibar())
}

#[tauri::command]
pub fn is_minibar_active_command() -> Result<bool, String> {
    Ok(is_minibar_active())
}

/// Tauri command: set or clear the file-picker-in-progress flag.
/// Called by the frontend before opening a native file picker dialog and again
/// after the dialog closes so focus-loss events do not trigger minibar mode.
#[cfg_attr(coverage_nightly, coverage(off))]
#[tauri::command]
pub fn set_file_picker_in_progress_command(active: bool) -> Result<(), String> {
    set_file_picker_in_progress(active);
    Ok(())
}

// ─── Tests ───────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minibar_starts_inactive() {
        assert!(!is_minibar_active());
    }

    #[test]
    fn enter_minibar_sets_active() {
        MINIBAR_ACTIVE.store(false, Ordering::SeqCst);
        let result = enter_minibar();
        assert!(result);
        assert!(is_minibar_active());
        // Reset
        MINIBAR_ACTIVE.store(false, Ordering::SeqCst);
    }

    #[test]
    fn exit_minibar_sets_inactive() {
        MINIBAR_ACTIVE.store(true, Ordering::SeqCst);
        let result = exit_minibar();
        assert!(!result);
        assert!(!is_minibar_active());
    }

    #[test]
    fn minibar_roundtrip() {
        MINIBAR_ACTIVE.store(false, Ordering::SeqCst);
        assert!(!is_minibar_active());
        enter_minibar();
        assert!(is_minibar_active());
        exit_minibar();
        assert!(!is_minibar_active());
    }

    #[test]
    fn set_main_hwnd_stores_value() {
        let test_hwnd = HWND(std::ptr::null_mut());
        set_main_hwnd(test_hwnd);
        unsafe {
            assert!(MAIN_HWND.is_some());
        }
        // Reset
        unsafe {
            MAIN_HWND = None;
        }
    }

    #[test]
    fn file_picker_in_progress_starts_false() {
        // Reset to a known state before the assertion.
        FILE_PICKER_IN_PROGRESS.store(false, Ordering::SeqCst);
        assert!(!FILE_PICKER_IN_PROGRESS.load(Ordering::SeqCst));
    }

    #[test]
    fn set_file_picker_in_progress_sets_flag() {
        FILE_PICKER_IN_PROGRESS.store(false, Ordering::SeqCst);
        set_file_picker_in_progress(true);
        assert!(FILE_PICKER_IN_PROGRESS.load(Ordering::SeqCst));
        set_file_picker_in_progress(false);
        assert!(!FILE_PICKER_IN_PROGRESS.load(Ordering::SeqCst));
        // Reset
        FILE_PICKER_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

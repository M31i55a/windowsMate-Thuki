//! Inline text editing: pastes the AI-generated response back into the source
//! application, replacing the text that was selected when Mate was opened.
//!
//! Flow:
//!   1. User selects text in any app → double-taps Ctrl to open Mate.
//!   2. `windows_activator::capture()` stores the HWND of the foreground window
//!      in `INLINE_EDIT_SOURCE_HWND` (before Ctrl+C shifts focus).
//!   3. User types an instruction in Mate (e.g. "translate to Spanish").
//!   4. App.tsx calls `apply_inline_edit` with the model's response.
//!   5. This module writes the response to the clipboard and simulates Ctrl+V
//!      in the source window, replacing the original selection.

use std::time::Duration;

use tauri::{Emitter, Manager};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_TYPE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VK_CONTROL, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

use crate::windows_activator;

// ─── Keyboard simulation ────────────────────────────────────────────────────

/// Simulates Ctrl+V (key-down then key-up for both keys).
#[cfg_attr(coverage_nightly, coverage(off))]
fn simulate_ctrl_v() {
    let inputs: [INPUT; 4] = [
        INPUT {
            r#type: INPUT_TYPE(1),
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_TYPE(1),
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_V,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_TYPE(1),
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_V,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_TYPE(1),
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

// ─── Paste logic ─────────────────────────────────────────────────────────────

/// Switches focus to the window identified by `raw_hwnd`, pastes `new_text`
/// over the current selection, then restores the previous clipboard contents.
#[cfg_attr(coverage_nightly, coverage(off))]
async fn paste_to_window(new_text: String, raw_hwnd: isize) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Reconstruct HWND inside the blocking thread (HWND is not Send).
        let hwnd = windows::Win32::Foundation::HWND(raw_hwnd as *mut _);

        // Save whatever was in the clipboard before we clobber it.
        let original = windows_activator::clipboard_text();
        windows_activator::write_clipboard(&new_text);

        // Bring the source window to the foreground so Ctrl+V lands there.
        unsafe {
            let _ = SetForegroundWindow(hwnd);
        }

        // Give the OS time to complete the focus switch and window hide before
        // sending keys. 300 ms is enough for Mate's exit animation to finish.
        std::thread::sleep(Duration::from_millis(300));
        simulate_ctrl_v();

        // Wait for the paste to be processed before restoring the clipboard.
        std::thread::sleep(Duration::from_millis(80));
        windows_activator::write_clipboard(&original);
    })
    .await
    .map_err(|e| format!("inline edit task failed: {e}"))
}

// ─── Public Tauri command ────────────────────────────────────────────────────

/// Core logic separated from the Tauri command boundary for testability.
pub(crate) async fn apply_inline_edit_impl(
    new_text: String,
    raw_hwnd: isize,
) -> Result<(), String> {
    if raw_hwnd == 0 {
        return Err("No source window captured — open Mate from a text selection.".into());
    }
    paste_to_window(new_text, raw_hwnd).await
}

/// Tauri command: writes `new_text` into the application that was in focus when
/// the user invoked Mate. Hides the Mate window first so it does not compete
/// for focus with the source application.
#[cfg_attr(not(coverage), tauri::command)]
pub async fn apply_inline_edit(new_text: String, app: tauri::AppHandle) -> Result<(), String> {
    let raw_hwnd = windows_activator::get_inline_edit_source_hwnd();
    if raw_hwnd == 0 {
        return Err("No source window captured — open Mate from a text selection.".into());
    }
    // Notify the frontend so it runs its proper hide animation and updates
    // its overlay state (eventually calls notify_overlay_hidden).
    let _ = app.emit("mate://visibility", serde_json::json!({ "state": "hide" }));
    // Also hide the native window immediately so it does not compete with
    // SetForegroundWindow on the source app side.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    apply_inline_edit_impl(new_text, raw_hwnd).await
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_error_when_no_source_hwnd() {
        let result = apply_inline_edit_impl("hello world".to_string(), 0).await;
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("No source window"),
            "error message should mention the missing source window"
        );
    }
}

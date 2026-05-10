//! Windows permissions module.
//!
//! On Windows, there are no Accessibility or Screen Recording permission gates.
//! All commands return success/true and settings commands open the relevant
//! Windows Settings pages.

/// Returns whether Accessibility permission has been granted.
/// On Windows, always returns true.
#[tauri::command]
#[cfg(target_os = "windows")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn check_accessibility_permission() -> bool {
    true
}

/// Opens Windows Settings to the Accessibility keyboard page.
#[tauri::command]
#[cfg(target_os = "windows")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn open_accessibility_settings() -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "ms-settings:easeofaccess-keyboard"])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Returns whether Screen Recording permission has been granted.
/// On Windows, always returns true.
#[tauri::command]
#[cfg(target_os = "windows")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn check_screen_recording_permission() -> bool {
    true
}

/// Opens Windows Settings to the Privacy page for graphics capture.
#[tauri::command]
#[cfg(target_os = "windows")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn open_screen_recording_settings() -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "ms-settings:privacy-graphicscapture"])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// On Windows, screen recording access is granted by default.
#[tauri::command]
#[cfg(target_os = "windows")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn request_screen_recording_access() -> bool {
    true
}

/// Returns true if screen recording is granted.
/// On Windows, always returns true.
#[tauri::command]
#[cfg(target_os = "windows")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn check_screen_recording_tcc_granted() -> bool {
    true
}

/// Restarts the application. On Windows, this updates the onboarding stage
/// before restarting.
#[tauri::command]
#[cfg(target_os = "windows")]
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn quit_and_relaunch(app_handle: tauri::AppHandle, db: tauri::State<crate::history::Database>) {
    if let Ok(conn) = db.0.lock() {
        let _ = crate::onboarding::set_stage(&conn, &crate::onboarding::OnboardingStage::Intro);
    }
    app_handle.restart();
}

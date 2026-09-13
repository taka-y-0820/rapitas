//! toast
//!
//! In-app notification toast window: pending-payload handoff state,
//! positioning/parking helpers and the Tauri commands used by the toast page.
//! Not responsible for OS-native (WinRT) notifications.

use tauri::{Emitter, Manager};

// Keep in sync with the layout in app/notification-toast/page.tsx.
const TOAST_WIDTH: f64 = 380.0;
const TOAST_HEIGHT: f64 = 116.0;
const TOAST_MARGIN: f64 = 16.0;
const TOAST_TASKBAR_ALLOWANCE: f64 = 48.0; // approximate Windows taskbar height

/// Toast handoff state. `pending` buffers the latest payload while the toast
/// page is still loading (an emit would be lost before its listener exists);
/// `ready` flips once the page called toast_ready, after which payloads are
/// delivered by emit alone (buffering then would replay stale toasts if the
/// window were ever recreated).
pub struct PendingToast {
    pub pending: std::sync::Mutex<Option<serde_json::Value>>,
    pub ready: std::sync::atomic::AtomicBool,
}

/// Tallest the toast may grow when a question's options are shown inline.
const TOAST_MAX_HEIGHT: f64 = 420.0;

/// Position the toast at the bottom-right of the primary monitor at the
/// default height.
fn position_toast(win: &tauri::WebviewWindow) {
    position_toast_with_height(win, TOAST_HEIGHT);
}

/// Position the toast at the bottom-right of the primary monitor, sized to
/// `height` (clamped to [TOAST_HEIGHT, TOAST_MAX_HEIGHT]) — the question toast
/// grows to fit its option buttons.
fn position_toast_with_height(win: &tauri::WebviewWindow, height: f64) {
    let height = height.clamp(TOAST_HEIGHT, TOAST_MAX_HEIGHT);
    // Re-assert the size on every show: external actors (Windows snap, the
    // split-view arranger before it learned to skip this window) can resize
    // the long-lived toast window, and a corrupted size otherwise persists
    // for the rest of the session.
    let _ = win.set_size(tauri::LogicalSize::new(TOAST_WIDTH, height));
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let _ = win.set_position(tauri::LogicalPosition::new(
            size.width - TOAST_WIDTH - TOAST_MARGIN,
            size.height - height - TOAST_TASKBAR_ALLOWANCE - TOAST_MARGIN,
        ));
    }
}

/// "Dismiss" = move the toast far off-screen, keeping it visible to Windows.
/// hide()/show() cycles are unusable here: tao's show maps to SW_SHOW, which
/// ACTIVATES the window (stealing focus on every notification), and a
/// visible(false) WebView2 never finishes navigating in the first place.
fn park_toast(win: &tauri::WebviewWindow) {
    let _ = win.set_position(tauri::LogicalPosition::new(0.0, -10000.0));
}

/// Create the toast window parked far off-screen so its page can load out of
/// sight. Called once during app setup (pre-warm) — creating it lazily at
/// notification time would steal focus mid-typing, but at boot the app owns
/// focus anyway. The page calls toast_ready when mounted; with no pending
/// payload the window simply hides until the first notification.
///
/// NOTE: the window is BUILT hidden and revealed only once it sits off-screen.
/// A window that is visible from build() flashes on screen no matter how it is
/// sized/positioned in the builder: Windows clamps a far-off-screen build
/// position back into the work area and a tiny size up to the minimum
/// tracking size — measured 2026-09-05 as a 136x39 px blank card at (130,130)
/// for ~230 ms on every boot. visible(false) alone would leave the WebView2
/// controller invisible (wry mirrors the flag into SetIsVisible, and the page
/// then never renders), so the webview is shown explicitly right after the
/// window. focused(false) stays out: it left WebView2 stuck at about:blank.
pub fn create_toast_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("notification-toast").is_some() {
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "notification-toast",
        tauri::WebviewUrl::App("notification-toast".into()),
    )
    .title("Rapitas Notification")
    .inner_size(TOAST_WIDTH, TOAST_HEIGHT)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .position(0.0, -10000.0)
    .visible(false)
    .build()
    .map_err(|e| format!("Failed to create toast window: {e}"))?;
    if let Some(win) = app.get_webview_window("notification-toast") {
        // The BUILDER position is clamped by Windows for a point this far
        // outside the virtual screen; set_position after creation is applied
        // as given, and while hidden nothing can be seen moving.
        park_toast(&win);
        let _ = win.set_size(tauri::LogicalSize::new(TOAST_WIDTH, TOAST_HEIGHT));
        // Reveal only now — the window is already parked, so this never paints
        // on screen. Window and webview are shown separately: the window show
        // maps the HWND, the webview show flips WebView2's IsVisible (see the
        // doc comment above).
        let _ = win.show();
        // AsRef<Webview> is the non-`unstable` route to the inner webview.
        let webview: &tauri::Webview = win.as_ref();
        let _ = webview.show();
    }
    Ok(())
}

/// Tauri command: show the app's own global toast window (bottom-right,
/// always-on-top). Used instead of Windows toast notifications, which are
/// silently droppable by OS settings/focus assist.
///
/// The payload goes through the PendingToast slot AND an emit — the slot
/// covers a page still loading (it pulls via toast_ready), the emit covers the
/// common case of the pre-warmed page already listening.
/// NOTE: the payload must NOT travel in the URL — WebviewUrl::App takes a
/// PathBuf, and a query string is an invalid Windows path (the window then
/// sticks at about:blank).
// NOTE: async so the handler runs on the thread pool — non-async commands run
// ON the main thread, where the win.url() getter below (a blocking round-trip
// into WebView2) can deadlock: the command then never completes, the toast
// never moves on-screen, and no error surfaces anywhere.
#[tauri::command]
pub async fn show_toast_window(
    app: tauri::AppHandle,
    title: String,
    body: String,
    link: Option<String>,
    memo_id: Option<i64>,
    task_id: Option<i64>,
    kind: Option<String>,
) -> Result<(), String> {
    // `taskId` + `kind: "question"` let the toast page fetch the pending
    // question's options and answer it in place, without opening the app.
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "link": link,
        "memoId": memo_id,
        "taskId": task_id,
        "kind": kind,
    });
    let ready = app
        .try_state::<PendingToast>()
        .map(|s| s.ready.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(false);
    if !ready {
        if let Some(state) = app.try_state::<PendingToast>() {
            *state.pending.lock().unwrap() = Some(payload.clone());
        }
    }

    if let Some(win) = app.get_webview_window("notification-toast") {
        // Self-heal: if anything navigated the toast window into the app
        // (stray click before the popup chrome was gated, etc.), send it back
        // to the toast route and let toast_ready deliver the buffered payload.
        let strayed = win
            .url()
            .map(|u| !u.path().starts_with("/notification-toast"))
            .unwrap_or(false);
        if strayed {
            if let Some(state) = app.try_state::<PendingToast>() {
                state
                    .ready
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                *state.pending.lock().unwrap() = Some(payload);
            }
            if let Ok(mut u) = win.url() {
                u.set_path("/notification-toast");
                u.set_query(None);
                let _ = win.navigate(u);
            }
            park_toast(&win);
            return Ok(());
        }
        if ready {
            // Moving into place never activates the window — no focus steal.
            position_toast(&win);
            let _ = win.emit("rapitas:toast", payload);
        }
        // Not ready: the page is still loading and will pull the pending
        // payload (and move into place) via toast_ready.
        return Ok(());
    }
    // Pre-warm missing (e.g. it failed at boot) — recreate; the page will pull
    // the pending payload via toast_ready when it finishes loading.
    create_toast_window(&app)
}

/// Tauri command: the toast page finished mounting. With a pending payload,
/// move the window into place and show it; without one (boot pre-warm) just
/// park it hidden until the first notification.
#[tauri::command]
pub fn toast_ready(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let payload = app.try_state::<PendingToast>().and_then(|s| {
        s.ready.store(true, std::sync::atomic::Ordering::SeqCst);
        s.pending.lock().unwrap().take()
    });
    if let Some(win) = app.get_webview_window("notification-toast") {
        if payload.is_some() {
            position_toast(&win);
        } else {
            park_toast(&win);
        }
    }
    payload
}

/// Tauri command: the toast page measured its content and wants the window
/// to grow/shrink to fit (question toasts list their options inline). The
/// window stays anchored to the bottom-right corner.
#[tauri::command]
pub fn toast_resize(app: tauri::AppHandle, height: f64) {
    if let Some(win) = app.get_webview_window("notification-toast") {
        position_toast_with_height(&win, height);
    }
}

/// Tauri command: dismiss the toast (auto-hide timer or the × button).
#[tauri::command]
pub fn toast_dismiss(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("notification-toast") {
        park_toast(&win);
    }
}

/// Tauri command: the toast body was clicked — hide the toast, bring the main
/// window forward, and let its router navigate to the notification's link.
#[tauri::command]
pub fn toast_navigate(app: tauri::AppHandle, link: Option<String>) {
    if let Some(win) = app.get_webview_window("notification-toast") {
        park_toast(&win);
    }
    crate::window_commands::show_main_window(&app);
    if let Some(l) = link {
        // emit_to, NOT a broadcast emit — the toast window itself also mounts
        // the app layout, and a broadcast would make ITS router navigate,
        // turning the tiny toast into a miniature copy of the app.
        let _ = app.emit_to("main", "rapitas:toast-navigate", l);
    }
}

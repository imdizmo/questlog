// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pages;
mod shell;
mod supervise;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::supervise::{Server, StartError};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_GRACE: Duration = Duration::from_secs(10);
/// How often the supervisor checks for a stop request or a dead server.
const POLL: Duration = Duration::from_millis(250);

/// What to do with a URL the webview wants to load.
#[derive(Debug, PartialEq)]
enum Nav {
    /// Load it in the window: the splash/error pages and the server's own UI.
    Allow,
    /// Cancel it and hand it to the system browser or mail client.
    External,
    /// Cancel it.
    Block,
}

/// `port` is the server's port once it is ready, 0 before.
fn classify(url: &Url, port: u16) -> Nav {
    match url.scheme() {
        // Our own pages. frontendDist (tauri:// / tauri.localhost) is never shown, so it is not allowed:
        // Tauri treats tauri.localhost on any port as local and would give that page IPC.
        "data" | "about" => Nav::Allow,
        "http" if port != 0 && url.host_str() == Some("127.0.0.1") && url.port() == Some(port) => Nav::Allow,
        "http" | "https" | "mailto" => Nav::External,
        _ => Nav::Block,
    }
}

/// Lets the window's close and the app's exit wait for the supervisor to stop the server.
struct Shutdown {
    stop: Mutex<Option<Sender<()>>>,
    done: Mutex<Option<Receiver<()>>>,
}

impl Shutdown {
    /// Asks the supervisor to stop the server and waits until it has. Later calls return at once.
    fn run(&self) {
        drop(self.stop.lock().ok().and_then(|mut s| s.take()));
        let done = self.done.lock().ok().and_then(|mut d| d.take());
        if let Some(done) = done {
            // The sender is dropped when the supervisor finishes.
            let _ = done.recv_timeout(STOP_GRACE + Duration::from_secs(5));
        }
    }
}

/// True once the app asked the supervisor to stop (the sender was dropped).
fn stop_requested(stop: &Receiver<()>) -> bool {
    !matches!(stop.try_recv(), Err(TryRecvError::Empty))
}

fn show(window: &WebviewWindow, html: &str) {
    match pages::data_url(html).parse() {
        Ok(url) => {
            if let Err(e) = window.navigate(url) {
                eprintln!("questlog: could not show page: {e}");
            }
        }
        Err(e) => eprintln!("questlog: bad page url: {e}"),
    }
}

/// Runs for the whole life of the app: it spawns the server (Linux ties the server's lifetime to this
/// thread via PR_SET_PDEATHSIG), waits for it, watches it, and stops it when asked.
fn supervise(window: WebviewWindow, app_dir: PathBuf, data: PathBuf, port_cell: Arc<AtomicU16>, stop: Receiver<()>) {
    let log_path = data.join("logs").join("server.log");
    let wait_for_stop = || {
        while matches!(stop.recv_timeout(POLL), Err(RecvTimeoutError::Timeout)) {}
    };

    // Held until this function returns, which is after the server has stopped.
    let _instance_lock = match shell::lock_instance(&data) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            eprintln!("questlog: already running (lock held on {})", data.join(shell::LOCK_FILE).display());
            let detail = format!(
                "Another Questlog window is already open and using {}. Switch to that window, or close it and \
                 start Questlog again.",
                data.display()
            );
            show(&window, &pages::error_page("Questlog is already running", &detail, &log_path, &[]));
            return wait_for_stop();
        }
        Err(e) => {
            let detail = format!("Questlog could not use its data folder {}: {e}", data.display());
            show(&window, &pages::error_page("Questlog could not start", &detail, &log_path, &[]));
            return wait_for_stop();
        }
    };
    let port = match shell::choose_port(&data) {
        Ok(p) => p,
        Err(e) => {
            let detail = format!("Questlog could not use its data folder {}: {e}", data.display());
            show(&window, &pages::error_page("Questlog could not start", &detail, &log_path, &[]));
            return wait_for_stop();
        }
    };
    let mut server = match Server::spawn(&app_dir, &data, port) {
        Ok(s) => s,
        Err(e) => {
            show(&window, &pages::spawn_error_page(&e, &app_dir, &log_path));
            return wait_for_stop();
        }
    };

    // Wait in short slices so closing the window during startup is not held up.
    let deadline = Instant::now() + READY_TIMEOUT;
    let ready = loop {
        if stop_requested(&stop) {
            return server.stop(STOP_GRACE);
        }
        let slice = deadline.saturating_duration_since(Instant::now()).min(POLL);
        match server.wait_ready(slice) {
            Err(StartError::Timeout { .. }) if Instant::now() < deadline => continue,
            other => break other,
        }
    };
    match ready {
        Ok(port) => {
            port_cell.store(port, Ordering::SeqCst);
            match format!("http://127.0.0.1:{port}/").parse() {
                Ok(url) => {
                    if let Err(e) = window.navigate(url) {
                        eprintln!("questlog: could not open the app: {e}");
                    }
                }
                Err(e) => eprintln!("questlog: bad app url: {e}"),
            }
        }
        Err(e) => {
            show(&window, &pages::start_error_page(&e, &data, &log_path));
            server.stop(STOP_GRACE); // after a timeout it may still be running
            return wait_for_stop();
        }
    }

    // Watch the running server until the app stops.
    while let Err(RecvTimeoutError::Timeout) = stop.recv_timeout(POLL) {
        if let Some(code) = server.exited() {
            port_cell.store(0, Ordering::SeqCst);
            show(&window, &pages::stopped_page(code, &log_path, &server.tail()));
            wait_for_stop();
            break;
        }
    }
    server.stop(STOP_GRACE);
}

fn open_external(app: &tauri::AppHandle, url: &Url) {
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("questlog: could not open {url}: {e}");
    }
}

/// The folder holding the Questlog executable, `runtime/`, `server/` and `web/`.
fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// WebView2 ships with Windows 10/11, but can be missing on stripped-down installs.
#[cfg(windows)]
fn require_webview2() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    if tauri::webview_version().is_ok() {
        return;
    }
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let text = wide(
        "Questlog needs the Microsoft Edge WebView2 Runtime, which is not installed on this computer.\n\n\
         Download the Evergreen runtime from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\n\
         Then start Questlog again.",
    );
    let caption = wide("Questlog");
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR);
    }
    std::process::exit(1);
}

fn main() {
    #[cfg(windows)]
    require_webview2();

    let data = shell::data_dir();
    let port_cell = Arc::new(AtomicU16::new(0));
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let shutdown = Arc::new(Shutdown { stop: Mutex::new(Some(stop_tx)), done: Mutex::new(Some(done_rx)) });

    let app = tauri::Builder::default()
        // Registered first, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup({
            let port_cell = port_cell.clone();
            let shutdown = shutdown.clone();
            move |app| {
                let splash: Url = pages::data_url(&pages::splash()).parse()?;
                let nav_app = app.handle().clone();
                let nav_port = port_cell.clone();
                let popup_app = app.handle().clone();
                let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(splash))
                    .title("Questlog")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(640.0, 480.0)
                    .center()
                    .on_navigation(move |url| match classify(url, nav_port.load(Ordering::SeqCst)) {
                        Nav::Allow => true,
                        Nav::External => {
                            open_external(&nav_app, url);
                            false
                        }
                        Nav::Block => false,
                    })
                    .on_new_window(move |url, _features| {
                        // target=_blank and window.open: in-app files and outside links open in the browser.
                        if matches!(url.scheme(), "http" | "https" | "mailto") {
                            open_external(&popup_app, &url);
                        }
                        NewWindowResponse::Deny
                    })
                    .build()?;

                let close_shutdown = shutdown.clone();
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        // Hidden first, so the wait for the server is not a frozen ("Not responding") window.
                        let _ = close_window.hide();
                        close_shutdown.run();
                    }
                });

                let data = data.clone();
                thread::Builder::new().name("supervisor".into()).spawn(move || {
                    supervise(window, app_dir(), data, port_cell, stop_rx);
                    drop(done_tx);
                })?;
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start Questlog");

    app.run(move |_app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            shutdown.run();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nav(url: &str, port: u16) -> Nav {
        classify(&url.parse().unwrap(), port)
    }

    #[test]
    fn server_origin_is_allowed_only_on_its_port() {
        assert_eq!(nav("http://127.0.0.1:8790/", 8790), Nav::Allow);
        assert_eq!(nav("http://127.0.0.1:8790/board?x=1#y", 8790), Nav::Allow);
        assert_eq!(nav("http://127.0.0.1:8791/", 8790), Nav::External);
        assert_eq!(nav("http://127.0.0.1:8790/", 0), Nav::External);
        assert_eq!(nav("https://127.0.0.1:8790/", 8790), Nav::External);
        assert_eq!(nav("http://localhost:8790/", 8790), Nav::External);
    }

    #[test]
    fn own_pages_are_allowed() {
        assert_eq!(nav("data:text/html;charset=utf-8,%3Cp%3Ehi", 0), Nav::Allow);
        assert_eq!(nav("about:blank", 0), Nav::Allow);
    }

    #[test]
    fn lookalikes_of_local_origins_are_not_allowed() {
        // frontendDist is never shown, so Tauri's own origins get no special treatment either.
        assert_eq!(nav("http://tauri.localhost:8790/", 8790), Nav::External);
        assert_eq!(nav("http://tauri.localhost/index.html", 8790), Nav::External);
        assert_eq!(nav("tauri://localhost/index.html", 8790), Nav::Block);
        assert_eq!(nav("http://127.0.0.1:8790@evil.com/", 8790), Nav::External);
        assert_eq!(nav("http://127.0.0.1.evil.com:8790/", 8790), Nav::External);
    }

    #[test]
    fn outside_links_open_externally_and_others_are_blocked() {
        assert_eq!(nav("https://example.com/a", 8790), Nav::External);
        assert_eq!(nav("mailto:someone@example.com", 8790), Nav::External);
        assert_eq!(nav("file:///etc/passwd", 8790), Nav::Block);
        assert_eq!(nav("javascript:alert(1)", 8790), Nav::Block);
    }
}

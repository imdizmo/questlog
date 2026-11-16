// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pages;
mod shell;
mod supervise;

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::shell::{DesktopConfig, Target};
use crate::supervise::{Server, StartError};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_GRACE: Duration = Duration::from_secs(10);
/// How often the supervisor checks for a stop request or a dead server.
const POLL: Duration = Duration::from_millis(250);
/// How long a team server gets to accept a TCP connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const BAD_ADDRESS: &str = "That address doesn't look right. Enter a name or IP address, like nas or 10.0.0.20:8780.";

/// What to do with a URL the webview wants to load.
#[derive(Debug, PartialEq)]
enum Nav {
    /// Load it in the window: the splash/error pages and the server's own UI.
    Allow,
    /// Cancel it and hand it to the system browser or mail client.
    External,
    /// Cancel it.
    Block,
    /// Cancel it and run the shell action it asks for.
    Shell(ShellAction),
}

/// An action asked for by the shell's own pages, as a navigation to `http://questlog-shell.invalid/<action>`.
#[derive(Debug, PartialEq)]
enum ShellAction {
    Local,
    Server(String),
    Retry,
    Change,
}

const SHELL_HOST: &str = "questlog-shell.invalid";

fn shell_action(url: &Url) -> Option<ShellAction> {
    if url.scheme() != "http" || url.host_str() != Some(SHELL_HOST) {
        return None;
    }
    match url.path() {
        "/local" => Some(ShellAction::Local),
        "/retry" => Some(ShellAction::Retry),
        "/change" => Some(ShellAction::Change),
        "/server" => {
            let (_, address) = url.query_pairs().find(|(k, _)| k == "address")?;
            Some(ShellAction::Server(address.into_owned()))
        }
        _ => None,
    }
}

/// `allowed` is the origin the window may load: `http://127.0.0.1:<port>` locally, the server's origin in server
/// mode, `None` before it is ready.
fn classify(url: &Url, allowed: Option<&Url>) -> Nav {
    if let Some(action) = shell_action(url) {
        return Nav::Shell(action);
    }
    match url.scheme() {
        // Our own pages. frontendDist (tauri:// / tauri.localhost) is never shown, so it is not allowed:
        // Tauri treats tauri.localhost on any port as local and would give that page IPC.
        "data" | "about" => Nav::Allow,
        "http" | "https"
            if allowed.is_some_and(|o| {
                url.scheme() == o.scheme()
                    && url.host_str().is_some()
                    && url.host_str() == o.host_str()
                    && url.port_or_known_default() == o.port_or_known_default()
            }) =>
        {
            Nav::Allow
        }
        "http" | "https" | "mailto" => Nav::External,
        _ => Nav::Block,
    }
}

/// What the window shows, as far as shell actions go.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Showing {
    /// The splash or an error page: no actions.
    Busy,
    /// The chooser or the unreachable page: one action may be taken.
    ShellPage,
    /// The server's UI, local or remote: never any actions, so a server's page cannot switch servers.
    App,
}

/// The navigation handler's view of the window, kept up to date by the supervisor.
struct NavGate {
    /// The origin the window may load (see `classify`).
    allowed: Option<Url>,
    showing: Showing,
}

impl NavGate {
    /// Classifies `url`. A shell action is passed on only from a shell page, and closes the gate until the
    /// supervisor shows the next one (so a double click does not queue a second action).
    fn decide(&mut self, url: &Url) -> Nav {
        match classify(url, self.allowed.as_ref()) {
            Nav::Shell(action) if self.showing == Showing::ShellPage => {
                self.showing = Showing::Busy;
                Nav::Shell(action)
            }
            Nav::Shell(_) => Nav::Block,
            other => other,
        }
    }
}

type Gate = Arc<Mutex<NavGate>>;

fn lock(gate: &Gate) -> MutexGuard<'_, NavGate> {
    gate.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the supervisor does next.
#[derive(Debug, PartialEq)]
enum Step {
    /// Save `"server": "local"` and run the local server.
    Local,
    /// Save this server and connect to it.
    Save(Url),
    /// Connect to this server.
    Connect(Url),
    /// Show the chooser, with an error line.
    Chooser(Option<&'static str>),
}

/// `last` is the server the unreachable page was about.
fn step(action: ShellAction, last: Option<&Url>) -> Step {
    match action {
        ShellAction::Local => Step::Local,
        ShellAction::Server(address) => match shell::address_url(&address) {
            Some(url) => Step::Save(url),
            None => Step::Chooser(Some(BAD_ADDRESS)),
        },
        ShellAction::Retry => match last {
            Some(url) => Step::Connect(url.clone()),
            None => Step::Chooser(None),
        },
        ShellAction::Change => Step::Chooser(None),
    }
}

/// A server URL as shown to the user.
fn display_address(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

/// Checks the server within `timeout` overall: for http, `GET /healthz` must answer `200` (so a wrong port that takes
/// connections, or a server that refuses this address, counts as not reached); for https, a TCP connection.
fn reach(url: &Url, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    let left = || -> io::Result<Duration> {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            Err(io::Error::new(io::ErrorKind::TimedOut, "connection timed out"))
        } else {
            Ok(left)
        }
    };
    let mut last = None;
    let mut stream = None;
    for addr in url.socket_addrs(|| None)? {
        let Ok(time) = left() else { break };
        match TcpStream::connect_timeout(&addr, time) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let Some(mut stream) = stream else {
        return Err(last.unwrap_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "connection timed out")));
    };
    if url.scheme() != "http" {
        return Ok(());
    }
    let host = match (url.host_str(), url.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        (None, _) => return Err(io::Error::new(io::ErrorKind::InvalidInput, "no host")),
    };
    stream.set_write_timeout(Some(left()?))?;
    stream.write_all(format!("GET /healthz HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes())?;
    // Only the status line matters; it is short, so stop at its end or after a small cap.
    let mut head = Vec::new();
    let mut buf = [0u8; 256];
    while !head.contains(&b'\n') && head.len() < 1024 {
        stream.set_read_timeout(Some(left()?))?;
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "no answer from the server"));
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let text = String::from_utf8_lossy(&head);
    healthz_status(text.split("\r\n").next().unwrap_or("").split('\n').next().unwrap_or(""))
}

/// Whether an HTTP status line answers 200; otherwise an error that says what came back.
fn healthz_status(line: &str) -> io::Result<()> {
    let mut parts = line.split_whitespace();
    let version = parts.next().unwrap_or("");
    let code = parts.next().unwrap_or("");
    if version.starts_with("HTTP/") && code == "200" {
        return Ok(());
    }
    let what = if version.starts_with("HTTP/") && code.len() == 3 && code.bytes().all(|b| b.is_ascii_digit()) {
        format!("the server answered {code}")
    } else {
        "no Questlog server answered at this address".to_string()
    };
    Err(io::Error::new(io::ErrorKind::InvalidData, what))
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

/// The supervisor's handle on the window and its inputs.
struct Ui {
    window: WebviewWindow,
    gate: Gate,
    stop: Receiver<()>,
    actions: Receiver<ShellAction>,
}

impl Ui {
    /// Shows one of the shell's own pages; `showing` is `Busy` or `ShellPage`.
    fn page(&self, html: &str, showing: Showing) {
        {
            let mut g = lock(&self.gate);
            g.allowed = None;
            g.showing = Showing::Busy;
        }
        // Stale actions (none are expected: the gate lets one through per page) are dropped.
        while self.actions.try_recv().is_ok() {}
        show(&self.window, html);
        // Safe to open before the new page has loaded: the supervisor never leaves the server's UI for a shell
        // page, so the page being replaced is the splash or another shell page.
        lock(&self.gate).showing = showing;
    }

    /// Lets the window load `url`'s origin and opens it.
    fn open_app(&self, url: &Url) {
        {
            let mut g = lock(&self.gate);
            g.allowed = Some(url.clone());
            g.showing = Showing::App;
        }
        if let Err(e) = self.window.navigate(url.clone()) {
            eprintln!("questlog: could not open {url}: {e}");
        }
    }

    fn wait_for_stop(&self) {
        while matches!(self.stop.recv_timeout(POLL), Err(RecvTimeoutError::Timeout)) {}
    }

    /// The next action from a shell page; `None` once the app is stopping.
    fn wait_action(&self) -> Option<ShellAction> {
        loop {
            if stop_requested(&self.stop) {
                return None;
            }
            match self.actions.recv_timeout(POLL) {
                Ok(action) => return Some(action),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.wait_for_stop();
                    return None;
                }
            }
        }
    }

    /// Checks that the server takes connections, without holding up a stop. `None` once the app is stopping.
    fn connect(&self, url: &Url) -> Option<io::Result<()>> {
        let (tx, rx) = mpsc::channel();
        let target = url.clone();
        // Ends by itself within the timeout (or the DNS lookup); a stop does not wait for it.
        thread::spawn(move || {
            let _ = tx.send(reach(&target, CONNECT_TIMEOUT));
        });
        loop {
            match rx.recv_timeout(POLL) {
                Ok(result) => return Some(result),
                Err(RecvTimeoutError::Timeout) if stop_requested(&self.stop) => return None,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Some(Err(io::Error::other("connection check failed"))),
            }
        }
    }
}

/// Runs for the whole life of the app: it takes the data folder's lock, works out where the window connects
/// (asking when it has to), and then either opens a team server or runs the local one.
fn supervise(ui: Ui, app_dir: PathBuf, data: PathBuf, team: Option<String>) {
    let log_path = data.join("logs").join("server.log");

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
            ui.page(&pages::error_page("Questlog is already running", &detail, &log_path, &[]), Showing::Busy);
            return ui.wait_for_stop();
        }
        Err(e) => {
            let detail = format!("Questlog could not use its data folder {}: {e}", data.display());
            ui.page(&pages::error_page("Questlog could not start", &detail, &log_path, &[]), Showing::Busy);
            return ui.wait_for_stop();
        }
    };

    // Before anything writes desktop.json: a fresh install has none, and that is what makes it ask.
    let cfg = DesktopConfig::load(&data);
    let mut next = match shell::resolve_target(cfg.as_ref(), team.as_deref()) {
        Target::Local => return run_local(&ui, &app_dir, &data, &log_path),
        Target::Server(url) => Step::Connect(url),
        Target::Ask => Step::Chooser(None),
    };
    let mut last: Option<Url> = None;
    loop {
        match next {
            Step::Local => {
                if let Err(e) = shell::save_server(&data, "local") {
                    eprintln!("questlog: could not save the choice: {e}");
                }
                ui.page(&pages::splash(), Showing::Busy);
                return run_local(&ui, &app_dir, &data, &log_path);
            }
            Step::Save(url) => {
                if let Err(e) = shell::save_server(&data, url.as_str()) {
                    eprintln!("questlog: could not save the choice: {e}");
                }
                next = Step::Connect(url);
                continue;
            }
            Step::Connect(url) => {
                ui.page(&pages::splash(), Showing::Busy);
                match ui.connect(&url) {
                    None => return,
                    Some(Ok(())) => {
                        ui.open_app(&url);
                        // No server of our own to stop: a close exits at once.
                        return ui.wait_for_stop();
                    }
                    Some(Err(e)) => {
                        eprintln!("questlog: cannot reach {url}: {e}");
                        ui.page(&pages::unreachable(&display_address(&url), &e.to_string()), Showing::ShellPage);
                        last = Some(url);
                    }
                }
            }
            Step::Chooser(error) => ui.page(&pages::chooser(error), Showing::ShellPage),
        }
        let Some(action) = ui.wait_action() else { return };
        next = step(action, last.as_ref());
    }
}

/// Spawns the local server (Linux ties its lifetime to this thread via PR_SET_PDEATHSIG), waits for it, watches
/// it, and stops it when asked.
fn run_local(ui: &Ui, app_dir: &Path, data: &Path, log_path: &Path) {
    let port = match shell::choose_port(data) {
        Ok(p) => p,
        Err(e) => {
            let detail = format!("Questlog could not use its data folder {}: {e}", data.display());
            ui.page(&pages::error_page("Questlog could not start", &detail, log_path, &[]), Showing::Busy);
            return ui.wait_for_stop();
        }
    };
    let mut server = match Server::spawn(app_dir, data, port) {
        Ok(s) => s,
        Err(e) => {
            ui.page(&pages::spawn_error_page(&e, app_dir, log_path), Showing::Busy);
            return ui.wait_for_stop();
        }
    };

    // Wait in short slices so closing the window during startup is not held up.
    let deadline = Instant::now() + READY_TIMEOUT;
    let ready = loop {
        if stop_requested(&ui.stop) {
            return server.stop(STOP_GRACE);
        }
        let slice = deadline.saturating_duration_since(Instant::now()).min(POLL);
        match server.wait_ready(slice) {
            Err(StartError::Timeout { .. }) if Instant::now() < deadline => continue,
            other => break other,
        }
    };
    match ready {
        Ok(port) => match format!("http://127.0.0.1:{port}/").parse() {
            Ok(url) => ui.open_app(&url),
            Err(e) => eprintln!("questlog: bad app url: {e}"),
        },
        Err(e) => {
            ui.page(&pages::start_error_page(&e, data, log_path), Showing::Busy);
            server.stop(STOP_GRACE); // after a timeout it may still be running
            return ui.wait_for_stop();
        }
    }

    // Watch the running server until the app stops.
    while let Err(RecvTimeoutError::Timeout) = ui.stop.recv_timeout(POLL) {
        if let Some(code) = server.exited() {
            ui.page(&pages::stopped_page(code, log_path, &server.tail()), Showing::Busy);
            ui.wait_for_stop();
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
    // Read once; never written.
    let team = std::env::var("JATIFY_TEAM").ok();
    let gate: Gate = Arc::new(Mutex::new(NavGate { allowed: None, showing: Showing::Busy }));
    let (action_tx, action_rx) = mpsc::channel::<ShellAction>();
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
            let gate = gate.clone();
            let shutdown = shutdown.clone();
            move |app| {
                let splash: Url = pages::data_url(&pages::splash()).parse()?;
                let nav_app = app.handle().clone();
                let nav_gate = gate.clone();
                let popup_app = app.handle().clone();
                let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(splash))
                    .title("Questlog")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(640.0, 480.0)
                    .center()
                    .on_navigation(move |url| {
                        let nav = lock(&nav_gate).decide(url);
                        match nav {
                            Nav::Allow => true,
                            Nav::External => {
                                open_external(&nav_app, url);
                                false
                            }
                            Nav::Block => false,
                            Nav::Shell(action) => {
                                let _ = action_tx.send(action);
                                false
                            }
                        }
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
                    let ui = Ui { window, gate, stop: stop_rx, actions: action_rx };
                    supervise(ui, app_dir(), data, team);
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
        let origin: Option<Url> = (port != 0).then(|| format!("http://127.0.0.1:{port}").parse().unwrap());
        classify(&url.parse().unwrap(), origin.as_ref())
    }

    fn nav_in(url: &str, allowed: &str) -> Nav {
        classify(&url.parse().unwrap(), Some(&allowed.parse().unwrap()))
    }

    fn gate(showing: Showing) -> NavGate {
        NavGate { allowed: None, showing }
    }

    #[test]
    fn shell_actions_only_from_shell_pages() {
        let local = "http://questlog-shell.invalid/local".parse::<Url>().unwrap();
        let server = "http://questlog-shell.invalid/server?address=evil".parse::<Url>().unwrap();
        // The server's UI (local or remote) cannot switch servers or turn on local mode.
        let mut g = NavGate { allowed: Some("http://nas:8780/".parse().unwrap()), showing: Showing::App };
        assert_eq!(g.decide(&local), Nav::Block);
        assert_eq!(g.decide(&server), Nav::Block);
        assert_eq!(g.showing, Showing::App);
        // Nor can anything while the shell is busy (splash, connecting, error pages).
        let mut g = gate(Showing::Busy);
        assert_eq!(g.decide(&local), Nav::Block);
        // A shell page can, once: the gate closes until the supervisor shows the next shell page.
        let mut g = gate(Showing::ShellPage);
        assert_eq!(g.decide(&server), Nav::Shell(ShellAction::Server("evil".into())));
        assert_eq!(g.showing, Showing::Busy);
        assert_eq!(g.decide(&local), Nav::Block);
    }

    #[test]
    fn gate_passes_other_navigations_through() {
        let mut g = NavGate { allowed: Some("http://nas:8780/".parse().unwrap()), showing: Showing::App };
        assert_eq!(g.decide(&"http://nas:8780/board".parse().unwrap()), Nav::Allow);
        assert_eq!(g.decide(&"https://example.com/".parse().unwrap()), Nav::External);
        let mut g = gate(Showing::ShellPage);
        assert_eq!(g.decide(&"data:text/html,x".parse().unwrap()), Nav::Allow);
        assert_eq!(g.showing, Showing::ShellPage);
    }

    #[test]
    fn actions_to_steps() {
        let nas: Url = "http://nas:8780/".parse().unwrap();
        assert_eq!(step(ShellAction::Local, None), Step::Local);
        assert_eq!(step(ShellAction::Server("nas".into()), None), Step::Save(nas.clone()));
        assert_eq!(
            step(ShellAction::Server("https://t.example/x".into()), Some(&nas)),
            Step::Save("https://t.example/".parse().unwrap())
        );
        assert_eq!(step(ShellAction::Server("ftp://nas".into()), None), Step::Chooser(Some(BAD_ADDRESS)));
        assert_eq!(step(ShellAction::Server("".into()), None), Step::Chooser(Some(BAD_ADDRESS)));
        assert_eq!(step(ShellAction::Retry, Some(&nas)), Step::Connect(nas.clone()));
        assert_eq!(step(ShellAction::Retry, None), Step::Chooser(None));
        assert_eq!(step(ShellAction::Change, Some(&nas)), Step::Chooser(None));
    }

    /// A one-shot server on 127.0.0.1 that reads the request and writes `answer` (or nothing, then waits).
    fn answer_once(answer: Option<&'static str>) -> (Url, thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url: Url = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port()).parse().unwrap();
        let handle = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 512];
            while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => req.extend_from_slice(&buf[..n]),
                }
            }
            match answer {
                Some(a) => s.write_all(a.as_bytes()).unwrap(),
                None => thread::sleep(Duration::from_millis(800)),
            }
            String::from_utf8_lossy(&req).into_owned()
        });
        (url, handle)
    }

    #[test]
    fn reach_asks_healthz_or_reports_the_error() {
        let (url, h) = answer_once(Some("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nok"));
        assert!(reach(&url, Duration::from_secs(2)).is_ok());
        let req = h.join().unwrap();
        let port = url.port().unwrap();
        assert!(req.starts_with("GET /healthz HTTP/1.0\r\n"), "{req}");
        assert!(req.contains(&format!("\r\nHost: 127.0.0.1:{port}\r\n")), "{req}");

        let (url, h) = answer_once(Some("HTTP/1.1 421 Misdirected Request\r\n\r\n"));
        let err = reach(&url, Duration::from_secs(2)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{err}");
        assert!(err.to_string().contains("421"), "{err}");
        h.join().unwrap();

        // Takes the connection but never answers: fails within the overall deadline.
        let (url, h) = answer_once(None);
        let started = Instant::now();
        let err = reach(&url, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut, "{err}");
        assert!(started.elapsed() < Duration::from_millis(700), "{:?}", started.elapsed());
        h.join().unwrap();

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url: Url = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port()).parse().unwrap();
        drop(listener);
        let err = reach(&url, Duration::from_secs(2)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionRefused, "{err}");
    }

    #[test]
    fn reach_https_only_connects() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url: Url = format!("https://127.0.0.1:{}/", listener.local_addr().unwrap().port()).parse().unwrap();
        assert!(reach(&url, Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn healthz_status_line() {
        assert!(healthz_status("HTTP/1.1 200 OK").is_ok());
        assert!(healthz_status("HTTP/1.0 200").is_ok());
        let e = healthz_status("HTTP/1.1 421 Misdirected Request").unwrap_err();
        assert_eq!(e.to_string(), "the server answered 421");
        assert!(healthz_status("HTTP/1.1 503 Service Unavailable").is_err());
        assert!(healthz_status("HTTP/1.1 2000 OK").is_err());
        assert!(healthz_status("SSH-2.0-OpenSSH_9.6 200").is_err());
        assert!(healthz_status("").is_err());
        assert_eq!(healthz_status("garbage").unwrap_err().to_string(), "no Questlog server answered at this address");
    }

    #[test]
    fn display_address_drops_trailing_slash() {
        assert_eq!(display_address(&"http://nas:8780/".parse().unwrap()), "http://nas:8780");
    }

    #[test]
    fn server_mode_origin_allow_list() {
        let o = "http://nas:8780/";
        assert_eq!(nav_in("http://nas:8780/board?x=1", o), Nav::Allow);
        assert_eq!(nav_in("http://nas:8781/", o), Nav::External);
        assert_eq!(nav_in("http://other:8780/", o), Nav::External);
        assert_eq!(nav_in("https://nas:8780/", o), Nav::External);
        assert_eq!(nav_in("https://nas/", "https://nas:443/"), Nav::Allow);
    }

    #[test]
    fn shell_actions() {
        assert_eq!(
            nav_in("http://questlog-shell.invalid/server?address=nas%3A8780", "http://nas:8780/"),
            Nav::Shell(ShellAction::Server("nas:8780".into()))
        );
        assert_eq!(nav("http://questlog-shell.invalid/local", 0), Nav::Shell(ShellAction::Local));
        assert_eq!(nav("http://questlog-shell.invalid/retry", 0), Nav::Shell(ShellAction::Retry));
        assert_eq!(nav("http://questlog-shell.invalid/change", 0), Nav::Shell(ShellAction::Change));
        assert_eq!(nav("http://questlog-shell.invalid/other", 0), Nav::External);
        assert_eq!(nav("https://questlog-shell.invalid/local", 0), Nav::External);
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

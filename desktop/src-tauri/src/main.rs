// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pages;
mod report;
mod shell;
mod signals;
mod strip;
mod supervise;

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, RunEvent, Url, Webview, WebviewUrl, Window, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::shell::{DesktopConfig, Mode, Target};
use crate::strip::{Current, StripAction, StripGate, StripNav};
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
    /// The crash prompt: send the report, don't, or show what it holds.
    CrashSend,
    CrashSkip,
    CrashView,
    /// From the crash report's details back to the prompt.
    CrashBack,
    /// From the crash report's result on to the normal start.
    Continue,
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
        "/crash-send" => Some(ShellAction::CrashSend),
        "/crash-skip" => Some(ShellAction::CrashSkip),
        "/crash-view" => Some(ShellAction::CrashView),
        "/crash-back" => Some(ShellAction::CrashBack),
        "/continue" => Some(ShellAction::Continue),
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
    // The strip's actions belong to the strip's own webview: here they are neither acted on nor opened outside.
    if strip::is_strip_host(url) {
        return Nav::Block;
    }
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
    /// The page the shell itself last navigated to (`show`).
    expected: Option<Url>,
}

impl NavGate {
    fn new() -> NavGate {
        NavGate { allowed: None, showing: Showing::Busy, expected: None }
    }

    /// Classifies `url`. A shell action is passed on only from a shell page, and closes the gate until the
    /// supervisor shows the next one (so a double click does not queue a second action). While the server's UI
    /// shows, a data:/about: page loads only when it is the one the shell itself is navigating to: a server's page
    /// cannot put up a look-alike of the shell's pages.
    fn decide(&mut self, url: &Url) -> Nav {
        if self.showing == Showing::App
            && matches!(url.scheme(), "data" | "about")
            && self.expected.as_ref() != Some(url)
        {
            return Nav::Block;
        }
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
        // Only the crash pages offer these; they are never shown once the start has moved on.
        ShellAction::CrashSend
        | ShellAction::CrashSkip
        | ShellAction::CrashView
        | ShellAction::CrashBack
        | ShellAction::Continue => Step::Chooser(None),
    }
}

/// Ids of the Workspace menu's items. Menu events come only from the native menu: the webview has no Tauri
/// permissions, so a server's page cannot raise one.
const MENU_TEAM: &str = "workspace-team";
const MENU_LOCAL: &str = "workspace-local";
const MENU_CHANGE: &str = "workspace-change";
const MENU_STRIP: &str = "workspace-strip";

/// An item of the Workspace menu.
#[derive(Debug, Clone, Copy, PartialEq)]
enum MenuAction {
    UseTeam,
    UseLocal,
    Change,
    /// Keyboard focus to the workspace strip (F6).
    FocusStrip,
}

fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        MENU_TEAM => Some(MenuAction::UseTeam),
        MENU_LOCAL => Some(MenuAction::UseLocal),
        MENU_CHANGE => Some(MenuAction::Change),
        MENU_STRIP => Some(MenuAction::FocusStrip),
        _ => None,
    }
}

/// Where the app works, as the Workspace menu sees it. Set by the supervisor.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Active {
    /// Not started yet, not the instance that holds the data folder, at the crash question, or restarting: the
    /// menu does nothing.
    Off,
    /// The chooser is showing.
    Choosing,
    /// On the team server or this computer (also on its "can't reach" or error page).
    Working(Mode),
}

/// What a click on the Workspace menu does.
#[derive(Debug, PartialEq)]
enum MenuMove {
    Nothing,
    /// Save the choice and restart into it.
    Switch(Mode),
    /// Restart into the chooser.
    Choose,
    /// Move the keyboard focus to the strip.
    FocusStrip,
}

/// `has_team`: a team address exists (a saved server URL or JATIFY_TEAM).
fn menu_move(action: MenuAction, active: Active, has_team: bool) -> MenuMove {
    match (active, action) {
        (_, MenuAction::FocusStrip) => MenuMove::FocusStrip,
        (Active::Off, _) => MenuMove::Nothing,
        (Active::Working(Mode::Team), MenuAction::UseTeam) | (Active::Working(Mode::Local), MenuAction::UseLocal) => {
            MenuMove::Nothing
        }
        (_, MenuAction::UseTeam) if !has_team => MenuMove::Nothing,
        (_, MenuAction::UseTeam) => MenuMove::Switch(Mode::Team),
        (_, MenuAction::UseLocal) => MenuMove::Switch(Mode::Local),
        (Active::Choosing, MenuAction::Change) => MenuMove::Nothing,
        (Active::Working(_), MenuAction::Change) => MenuMove::Choose,
    }
}

fn active_for(target: &Target) -> Active {
    match target {
        Target::Server(_) => Active::Working(Mode::Team),
        Target::Local => Active::Working(Mode::Local),
        Target::Ask => Active::Choosing,
    }
}

/// What a click in the workspace strip does.
#[derive(Debug, PartialEq)]
enum StripMove {
    Nothing,
    /// Save "this computer" and restart into it.
    Local,
    /// Save this team server and restart into it.
    Server(Url),
    /// Restart into the chooser.
    Choose,
    /// Keyboard focus back to the page.
    FocusApp,
}

/// `serving`: the team server the app works on (when `active` is the team). `known`: the servers the strip offers
/// (`shell::known_servers`); a server action for any other address does nothing.
fn strip_move(action: &StripAction, active: Active, serving: Option<&Url>, known: &[Url]) -> StripMove {
    match (active, action) {
        (_, StripAction::App) => StripMove::FocusApp,
        (Active::Off, _) => StripMove::Nothing,
        (Active::Working(Mode::Local), StripAction::Local) => StripMove::Nothing,
        (_, StripAction::Local) => StripMove::Local,
        (_, StripAction::Server(address)) => match shell::saved_url(address).filter(|u| known.contains(u)) {
            None => StripMove::Nothing,
            Some(url) if active == Active::Working(Mode::Team) && serving == Some(&url) => StripMove::Nothing,
            Some(url) => StripMove::Server(url),
        },
        (Active::Choosing, StripAction::Choose) => StripMove::Nothing,
        (Active::Working(_), StripAction::Choose) => StripMove::Choose,
    }
}

/// What the strip highlights.
fn current_of(active: Active, serving: Option<&Url>) -> Current {
    match (active, serving) {
        (Active::Off, _) => Current::Nothing,
        (Active::Choosing, _) => Current::Choosing,
        (Active::Working(Mode::Local), _) => Current::Local,
        (Active::Working(Mode::Team), Some(url)) => Current::Team(url.clone()),
        (Active::Working(Mode::Team), None) => Current::Nothing,
    }
}

/// The Workspace menu's items.
struct WorkspaceMenu {
    team: CheckMenuItem<tauri::Wry>,
    local: CheckMenuItem<tauri::Wry>,
    /// "Go to the workspace strip" (F6): off when the strip could not be docked (and is hidden).
    strip: MenuItem<tauri::Wry>,
}

/// The Workspace menu's and the strip's state, shared by the supervisor (which sets `active`) and their handlers.
struct Workspace {
    active: Mutex<Active>,
    /// The team server the app works on (or tries to reach), for the strip's highlight.
    serving: Mutex<Option<Url>>,
    menu: WorkspaceMenu,
    window: Window,
    /// The webview that shows the shell's pages and the server's UI.
    view: Webview,
    /// The workspace strip's webview and its navigation gate.
    strip: Webview,
    strip_gate: Arc<Mutex<StripGate>>,
    /// The strip is shown beside the page (`dock`); false when it had to be hidden.
    docked: bool,
    data: PathBuf,
    /// `JATIFY_TEAM`, as read at start.
    team: Option<String>,
    gate: Gate,
    shutdown: Arc<Shutdown>,
}

impl Workspace {
    fn active(&self) -> Active {
        *self.active.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn serving(&self) -> Option<Url> {
        self.serving.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn known_servers(&self) -> Vec<Url> {
        shell::known_servers(DesktopConfig::load(&self.data).as_ref(), self.team.as_deref())
    }

    fn has_team(&self) -> bool {
        shell::team_address(DesktopConfig::load(&self.data).as_ref(), self.team.as_deref()).is_some()
    }

    /// Puts the check marks and the team item's state in line with `active` (a click toggles a check item by
    /// itself), and the strip. On the main thread only: menu calls from another thread wait for it.
    fn sync(&self) {
        let active = self.active();
        let _ = self.menu.team.set_checked(active == Active::Working(Mode::Team));
        let _ = self.menu.local.set_checked(active == Active::Working(Mode::Local));
        let _ = self.menu.team.set_enabled(self.has_team());
        self.render_strip();
    }

    /// Shows the strip for the current state; an unchanged strip is left as it is (no reload, focus kept).
    fn render_strip(&self) {
        let active = self.active();
        let current = current_of(active, self.serving().as_ref());
        let html = strip::page(&self.known_servers(), &current, active == Active::Off);
        let url = {
            let mut g = self.strip_gate.lock().unwrap_or_else(|p| p.into_inner());
            if g.html == html && g.expected.is_some() {
                return;
            }
            let Some(url) = page_url(&html) else { return };
            g.html = html;
            g.expected = Some(url.clone());
            url
        };
        if let Err(e) = self.strip.navigate(url) {
            shell::dlog(&format!("could not show the workspace strip: {e}"));
        }
    }
}

/// Builds the menu bar with its Workspace menu (on macOS after the standard app menus).
fn workspace_menu(app: &AppHandle) -> tauri::Result<(Menu<tauri::Wry>, WorkspaceMenu)> {
    let team = CheckMenuItem::with_id(app, MENU_TEAM, "Use the &team server", false, false, None::<&str>)?;
    let local = CheckMenuItem::with_id(app, MENU_LOCAL, "Use this &computer", true, false, None::<&str>)?;
    let change = MenuItem::with_id(app, MENU_CHANGE, "C&hange server…", true, None::<&str>)?;
    let strip = MenuItem::with_id(app, MENU_STRIP, "Go to the workspace &strip", true, Some("F6"))?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let submenu = Submenu::with_items(app, "&Workspace", true, &[&team, &local, &change, &separator, &strip])?;
    #[cfg(target_os = "macos")]
    let menu = {
        let menu = Menu::default(app)?;
        menu.append(&submenu)?;
        menu
    };
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&submenu])?;
    Ok((menu, WorkspaceMenu { team, local, strip }))
}

/// Handles a click on the Workspace menu (main thread). A switch saves the choice, then restarts the supervisor in
/// this process (see `Shutdown::restart`).
fn on_menu(ws: &Workspace, id: &str) {
    let Some(action) = menu_action(id) else { return };
    let mv = menu_move(action, ws.active(), ws.has_team());
    match mv {
        MenuMove::Nothing => ws.sync(),
        MenuMove::Switch(mode) => {
            let team = ws.team.as_deref();
            switch(ws, &format!("workspace menu: switch to {mode:?}"), |cfg| {
                shell::switch_choice(cfg.as_ref(), team, mode)
            });
        }
        MenuMove::Choose => {
            shell::dlog("workspace menu: change server, restarting");
            restart(ws, Restart::Choose);
        }
        // Never to a hidden strip (its menu item is off then too).
        MenuMove::FocusStrip if ws.docked => {
            let _ = ws.strip.set_focus();
        }
        MenuMove::FocusStrip => {}
    }
}

/// Handles a click in the workspace strip (main thread), as the Workspace menu's items do.
fn on_strip(ws: &Workspace, action: StripAction) {
    let known = ws.known_servers();
    let team = ws.team.as_deref();
    match strip_move(&action, ws.active(), ws.serving().as_ref(), &known) {
        StripMove::Nothing => ws.sync(),
        StripMove::Local => {
            switch(ws, "workspace strip: switch to Local", |cfg| shell::switch_choice(cfg.as_ref(), team, Mode::Local))
        }
        StripMove::Server(url) => {
            let what = format!("workspace strip: switch to {}", display_address(&url));
            switch(ws, &what, |cfg| shell::switch_server(cfg.as_ref(), team, &url))
        }
        StripMove::Choose => {
            shell::dlog("workspace strip: change server, restarting");
            restart(ws, Restart::Choose);
        }
        StripMove::FocusApp => {
            let _ = ws.view.set_focus();
        }
    }
}

/// Saves the choice `change` makes and restarts into it; when it cannot be saved, nothing changes.
fn switch(ws: &Workspace, what: &str, change: impl FnOnce(Option<DesktopConfig>) -> DesktopConfig) {
    match shell::update_config(&ws.data, change) {
        Ok(cfg) => {
            shell::dlog(&format!("{what} (server {:?}), restarting", cfg.server));
            restart(ws, Restart::Saved);
        }
        Err(e) => {
            eprintln!("questlog: could not save the choice: {e}");
            shell::dlog(&format!("{what}: could not save the choice: {e}"));
            ws.sync();
        }
    }
}

/// Restarts in this process, not with `AppHandle::restart`/`request_restart`: those spawn a new process and exit,
/// and when the Jatify Launcher runs Questlog as a systemd user service, systemd stops the service (killing the new
/// process too) as soon as the old main process exits.
fn restart(ws: &Workspace, how: Restart) {
    *ws.active.lock().unwrap_or_else(|p| p.into_inner()) = Active::Off;
    ws.render_strip();
    // Off the server's UI at once: no shell actions, no navigation within its origin, the splash while it stops.
    {
        let mut g = lock(&ws.gate);
        g.allowed = None;
        g.showing = Showing::Busy;
    }
    let _ = ws.window.set_title("Questlog");
    show(&ws.view, &ws.gate, &pages::splash());
    // The next run starts once this one has returned (local server stopped, running marker cleared, data-folder
    // lock released), however long the server takes: unlike `Shutdown::run`, which gives up after STOP_GRACE + 5 s
    // and lets the process exit, nothing here can overrun. A switch while the app is closing is dropped.
    if !ws.shutdown.restart(how) {
        shell::dlog("workspace menu: the app is closing, not restarting");
    }
}

/// The crash report pages.
#[derive(Debug, Clone, Copy, PartialEq)]
enum CrashPage {
    Prompt,
    Details,
    Result,
}

/// What the crash flow does next.
#[derive(Debug, PartialEq)]
enum CrashMove {
    Show(CrashPage),
    /// Build and upload the report, then show the result.
    Send,
    /// Go on to the normal start.
    Start,
    /// Not an action of this page: show it again.
    Stay,
}

fn crash_move(page: CrashPage, action: &ShellAction) -> CrashMove {
    match (page, action) {
        (CrashPage::Prompt, ShellAction::CrashSend) => CrashMove::Send,
        (CrashPage::Prompt, ShellAction::CrashSkip) => CrashMove::Start,
        (CrashPage::Prompt, ShellAction::CrashView) => CrashMove::Show(CrashPage::Details),
        (CrashPage::Details, ShellAction::CrashBack) => CrashMove::Show(CrashPage::Prompt),
        (CrashPage::Result, ShellAction::Continue) => CrashMove::Start,
        _ => CrashMove::Stay,
    }
}

/// How long sending a crash report may take, all told.
const CRASH_TIMEOUT: Duration = Duration::from_secs(30);

/// What a crash report says about this build.
#[derive(Clone)]
struct BuildInfo {
    /// The app's version as packaged (Tauri's package info, stamped by the release build).
    version: String,
    /// `JATIFY_MEMORY_MAX`, read once at start.
    memory_max: Option<u64>,
}

fn crash_report(data: &Path, build: &BuildInfo) -> Vec<(String, Vec<u8>)> {
    report::build_report(data, &build.version, report::os_name(), build.memory_max, report::MAX_REPORT_BYTES)
}

/// Offers to send a crash report to the team server and does what the user picks. `false` once the app is stopping.
fn offer_crash_report(ui: &Ui, data: &Path, team: &Url, build: &BuildInfo) -> bool {
    let mut page = CrashPage::Prompt;
    let mut html = pages::crash_prompt();
    loop {
        if !ui.page(&html, Showing::ShellPage) {
            // A page that cannot be shown must not leave the user stuck: details fall back to the prompt; a prompt
            // or result that cannot be shown goes on to the normal start.
            if page == CrashPage::Details {
                shell::dlog("crash report: details page could not be shown, back to the prompt");
                html = pages::crash_prompt();
                page = CrashPage::Prompt;
                continue;
            }
            shell::dlog("crash report: page could not be shown, starting");
            return true;
        }
        let Some(action) = ui.wait_action() else {
            shell::dlog("crash report: stopped while prompting");
            return false;
        };
        match crash_move(page, &action) {
            CrashMove::Stay => {}
            CrashMove::Start => {
                shell::dlog(if page == CrashPage::Prompt { "crash report: not sent" } else { "crash report: continue" });
                return true;
            }
            CrashMove::Show(CrashPage::Details) => {
                shell::dlog("crash report: showing what is sent");
                html = pages::crash_details_for(&crash_report(data, build));
                page = CrashPage::Details;
            }
            CrashMove::Show(_) => {
                html = pages::crash_prompt();
                page = CrashPage::Prompt;
            }
            CrashMove::Send => {
                shell::dlog("crash report: sending");
                ui.page(&pages::crash_sending(), Showing::Busy);
                let Some(result) = ui.send_report(data, team, build) else {
                    shell::dlog("crash report: stopped while sending");
                    return false;
                };
                match &result {
                    Ok(id) => shell::dlog(&format!("crash report: sent as {}", report::one_line(id))),
                    Err(e) => shell::dlog(&format!("crash report: not sent: {e}")),
                }
                html = pages::crash_result(result);
                page = CrashPage::Result;
            }
        }
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

/// How the supervisor starts again after a Workspace menu restart.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Restart {
    /// From the saved choice, as a start does.
    Saved,
    /// With the chooser ("Change server…").
    Choose,
}

/// What the supervisor's thread holds between runs: the current run's stop sender, a pending restart, and whether
/// the app is closing.
struct Rounds {
    /// Dropping it stops the current run. `None` once stopped.
    stop: Option<Sender<()>>,
    restart: Option<Restart>,
    quitting: bool,
}

/// Lets the window's close and the app's exit wait for the supervisor to stop the server, and the Workspace menu
/// restart it.
struct Shutdown {
    rounds: Mutex<Rounds>,
    done: Mutex<Option<Receiver<()>>>,
}

impl Shutdown {
    fn rounds(&self) -> MutexGuard<'_, Rounds> {
        self.rounds.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Stops the current run so the supervisor starts a new one. False when the app is closing.
    fn restart(&self, how: Restart) -> bool {
        let mut r = self.rounds();
        if r.quitting {
            return false;
        }
        r.restart = Some(how);
        drop(r.stop.take());
        true
    }

    /// For the supervisor after a run: the next run's stop receiver and how it starts, or `None` when the app is
    /// closing (or the run ended without a restart asked for).
    fn next_round(&self) -> Option<(Receiver<()>, Restart)> {
        let mut r = self.rounds();
        if r.quitting {
            return None;
        }
        let how = r.restart.take()?;
        let (tx, rx) = mpsc::channel();
        r.stop = Some(tx);
        Some((rx, how))
    }

    /// Asks the supervisor to stop the server and waits until it has. Later calls return at once.
    fn run(&self) {
        {
            let mut r = self.rounds();
            r.quitting = true;
            drop(r.stop.take());
        }
        let done = self.done.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(done) = done {
            // The sender is dropped when the supervisor finishes.
            let _ = done.recv_timeout(STOP_GRACE + Duration::from_secs(5));
        }
        // The supervisor has normally done this already, before its lock dropped; this covers one that did not
        // finish in time. Once only, and only for the process that holds the lock.
        shell::exit_clean();
    }
}

/// Events after which the app is going away: ExitRequested, and Exit, which also arrives when the OS ends the
/// session without an ExitRequested first.
fn ends_run(event: &RunEvent) -> bool {
    matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit)
}

/// True once the app asked the supervisor to stop (the sender was dropped).
fn stop_requested(stop: &Receiver<()>) -> bool {
    !matches!(stop.try_recv(), Err(TryRecvError::Empty))
}

/// A one-time value, so each page the shell shows has a URL nothing else can know in advance.
fn nonce() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let part = || {
        // Each RandomState has fresh keys from the OS's randomness (bumped per call).
        let mut h = RandomState::new().build_hasher();
        h.write_u64(n);
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

/// The data: URL for one showing of a shell page: `html` with a one-time nonce in it (in the document, not a
/// fragment, so showing the same page again is a new load).
fn page_url(html: &str) -> Option<Url> {
    pages::data_url(&format!("{html}<!--{}-->", nonce())).parse().ok()
}

/// Shows a page; the URL it navigated to (recorded in the gate first), or `None` when it could not.
fn show(view: &Webview, gate: &Gate, html: &str) -> Option<Url> {
    let Some(url) = page_url(html) else {
        eprintln!("questlog: bad page url");
        return None;
    };
    lock(gate).expected = Some(url.clone());
    match view.navigate(url.clone()) {
        Ok(()) => Some(url),
        Err(e) => {
            eprintln!("questlog: could not show page: {e}");
            shell::dlog(&format!("could not show page: {e}"));
            None
        }
    }
}

/// How a wait for a page to load ended.
#[derive(Debug, PartialEq)]
enum Waited {
    Loaded,
    TimedOut,
    Stopped,
}

/// Waits for `want` to load: a load event (committed or finished) whose URL is exactly `want`. Another page's load,
/// another data: URL included, does not count; a load that was cancelled never reports `want`.
fn wait_for_page(loads: &Receiver<Url>, want: &Url, stop: &Receiver<()>, timeout: Duration) -> Waited {
    let deadline = Instant::now() + timeout;
    loop {
        if stop_requested(stop) {
            return Waited::Stopped;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Waited::TimedOut;
        }
        match loads.recv_timeout(left.min(POLL)) {
            Ok(url) if url == *want => return Waited::Loaded,
            Ok(_) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Waited::TimedOut,
        }
    }
}

/// The supervisor's handle on the window and its inputs.
struct Ui {
    window: Window,
    /// The webview that shows the shell's pages and the server's UI (not the strip).
    view: Webview,
    gate: Gate,
    stop: Receiver<()>,
    actions: Receiver<ShellAction>,
    workspace: Arc<Workspace>,
    /// URLs of committed and finished page loads (bounded; extra loads are dropped).
    loads: Receiver<Url>,
}

/// How long a restart waits for the splash to replace the page that was showing.
const SPLASH_LOAD_TIMEOUT: Duration = Duration::from_secs(10);

impl Ui {
    /// Before a restarted run: shows this showing's splash and waits until it has loaded, so the page that was
    /// showing (maybe a server's UI) is gone before the run may show a shell page and open the gate to actions.
    /// False when that cannot be shown to be the case (or the app stopped); the run must not start then.
    fn fresh_start(&self) -> bool {
        while self.loads.try_recv().is_ok() {}
        self.set_active(Active::Off);
        let Some(want) = self.show_page(&pages::splash(), Showing::Busy) else {
            return false;
        };
        match wait_for_page(&self.loads, &want, &self.stop, SPLASH_LOAD_TIMEOUT) {
            Waited::Loaded => true,
            Waited::Stopped => false,
            Waited::TimedOut => {
                shell::dlog("restart: the splash did not load in time");
                false
            }
        }
    }

    fn set_title(&self, title: &str) {
        if let Err(e) = self.window.set_title(title) {
            eprintln!("questlog: could not set the title: {e}");
        }
    }

    /// Where the app now works: the title, the Workspace menu and the strip follow.
    fn working(&self, target: &Target) {
        *self.workspace.serving.lock().unwrap_or_else(|p| p.into_inner()) = match target {
            Target::Server(url) => Some(url.clone()),
            _ => None,
        };
        self.set_active(active_for(target));
        self.set_title(&shell::title_for(target));
    }

    fn set_active(&self, active: Active) {
        *self.workspace.active.lock().unwrap_or_else(|p| p.into_inner()) = active;
        // Posted, not waited for: the main thread may be waiting for this thread in `Shutdown::run`.
        let ws = self.workspace.clone();
        let _ = self.window.app_handle().run_on_main_thread(move || ws.sync());
    }

    /// Shows the splash while the app connects or starts, with the title for `target`.
    fn starting(&self, target: &Target) {
        self.page(&pages::splash(), Showing::Busy);
        self.working(target);
    }

    /// Shows one of the shell's own pages, titled plain `Questlog`; `showing` is `Busy` or `ShellPage`. False when
    /// it could not be shown (the gate then stays closed).
    fn page(&self, html: &str, showing: Showing) -> bool {
        self.show_page(html, showing).is_some()
    }

    /// `page`, giving the URL it navigated to.
    fn show_page(&self, html: &str, showing: Showing) -> Option<Url> {
        self.set_title("Questlog");
        {
            let mut g = lock(&self.gate);
            g.allowed = None;
            g.showing = Showing::Busy;
        }
        // Stale actions (none are expected: the gate lets one through per page) are dropped.
        while self.actions.try_recv().is_ok() {}
        let url = show(&self.view, &self.gate, html)?;
        // Safe to open before the new page has loaded: the supervisor never leaves the server's UI for a shell
        // page (a restart first waits for its own splash, `fresh_start`), so the page being replaced is the splash
        // or another shell page.
        lock(&self.gate).showing = showing;
        Some(url)
    }

    /// Lets the window load `url`'s origin and opens it.
    fn open_app(&self, url: &Url) {
        {
            let mut g = lock(&self.gate);
            g.allowed = Some(url.clone());
            g.showing = Showing::App;
        }
        if let Err(e) = self.view.navigate(url.clone()) {
            eprintln!("questlog: could not open {url}: {e}");
        }
    }

    /// Builds the crash report and uploads it on a helper thread, without holding up a stop. `None` once the app
    /// is stopping.
    fn send_report(&self, data: &Path, team: &Url, build: &BuildInfo) -> Option<Result<String, String>> {
        let (tx, rx) = mpsc::channel();
        let data = data.to_path_buf();
        let build = build.clone();
        let url = report::crash_url(team, &build.version, report::os_name());
        // Ends by itself within the upload's overall timeout; a stop does not wait for it.
        thread::spawn(move || {
            let zip = report::zip_stored(&crash_report(&data, &build));
            let _ = tx.send(report::upload(&url, &zip, CRASH_TIMEOUT));
        });
        loop {
            match rx.recv_timeout(POLL) {
                Ok(result) => return Some(result),
                Err(RecvTimeoutError::Timeout) if stop_requested(&self.stop) => return None,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Some(Err("the report could not be made".to_string())),
            }
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
/// `ask`: show the chooser instead of the saved choice ("Change server…" in the Workspace menu).
fn supervise(ui: &Ui, app_dir: &Path, data: &Path, team: Option<&str>, build: &BuildInfo, ask: bool) {
    let log_path = data.join("logs").join("server.log");

    // Held until this function returns, which is after the server has stopped.
    let _instance_lock = match shell::lock_instance(data) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            // No desktop.log here: it belongs to the instance that holds the lock.
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
            eprintln!("questlog: {detail}");
            ui.page(&pages::error_page("Questlog could not start", &detail, &log_path, &[]), Showing::Busy);
            return ui.wait_for_stop();
        }
    };
    // Only the lock holder writes desktop.log, so two processes never append to (or rotate) it at once.
    shell::init_desktop_log(data);
    // Dropped before `_instance_lock` (reverse order): the marker is cleared while the lock is still held, so a new
    // instance that takes the lock right after cannot have its fresh marker deleted by this one.
    let _exit = ExitClean;

    // Only the instance that holds the lock owns the marker. `shell::last_run_ended_badly()` says whether the
    // previous run left one behind (read by the crash prompt).
    let crashed = shell::mark_running_owned(data);
    shell::dlog(&format!(
        "start questlog {} pid {} previous run {}",
        build.version,
        std::process::id(),
        if crashed { "ended badly" } else { "ended cleanly" }
    ));

    // Before anything writes desktop.json: a fresh install has none, and that is what makes it ask.
    let cfg = DesktopConfig::load(data);
    let target = if ask {
        shell::dlog("chooser asked for from the workspace menu");
        Target::Ask
    } else {
        shell::resolve_target(cfg.as_ref(), team)
    };
    shell::dlog(&format!("target {}", target.log_text()));

    // Before the target starts. The marker for this run is already fresh either way.
    if shell::last_run_ended_badly() {
        match team.and_then(shell::team_url) {
            Some(team_url) => {
                shell::dlog("crash report: offered");
                if !offer_crash_report(ui, data, &team_url, build) {
                    return;
                }
                ui.page(&pages::splash(), Showing::Busy);
            }
            None => shell::dlog("crash report: not offered, no team server set"),
        }
    }
    let mut next = match target {
        Target::Local => {
            ui.working(&Target::Local);
            return run_local(ui, app_dir, data, team, &log_path);
        }
        Target::Server(url) => Step::Connect(url),
        Target::Ask => Step::Chooser(None),
    };
    let mut last: Option<Url> = None;
    loop {
        match next {
            Step::Local => {
                // As the Workspace menu's "Use this computer" does: a typed server is kept as last_server.
                if let Err(e) = shell::update_config(data, |c| shell::switch_choice(c.as_ref(), team, Mode::Local)) {
                    eprintln!("questlog: could not save the choice: {e}");
                }
                ui.starting(&Target::Local);
                return run_local(ui, app_dir, data, team, &log_path);
            }
            Step::Save(url) => {
                if let Err(e) = shell::save_server(data, url.as_str()) {
                    eprintln!("questlog: could not save the choice: {e}");
                }
                next = Step::Connect(url);
                continue;
            }
            Step::Connect(url) => {
                ui.starting(&Target::Server(url.clone()));
                match ui.connect(&url) {
                    None => return,
                    Some(Ok(())) => {
                        ui.open_app(&url);
                        // No server of our own to stop: a close exits at once.
                        return ui.wait_for_stop();
                    }
                    Some(Err(e)) => {
                        eprintln!("questlog: cannot reach {url}: {e}");
                        shell::dlog(&format!("cannot reach {}: {e}", display_address(&url)));
                        ui.page(&pages::unreachable(&display_address(&url), &e.to_string()), Showing::ShellPage);
                        last = Some(url);
                    }
                }
            }
            Step::Chooser(error) => {
                ui.page(&pages::chooser(error), Showing::ShellPage);
                ui.set_active(Active::Choosing);
            }
        }
        let Some(action) = ui.wait_action() else { return };
        next = step(action, last.as_ref());
    }
}

/// The supervisor thread's runs, as `run_rounds` drives them.
trait Runs {
    /// One run (`supervise`); returns once its stop receiver says so. `ask`: start with the chooser.
    fn run(&mut self, ask: bool);
    fn set_stop(&mut self, stop: Receiver<()>);
    fn stopped(&self) -> bool;
    /// Shows the restart's splash and proves it loaded (`Ui::fresh_start`).
    fn fresh_start(&mut self) -> bool;
    /// The splash could not be shown: a Busy error page, until the app stops.
    fn give_up(&mut self);
}

/// Runs the supervisor, and again after each Workspace menu restart, until the app closes. A run starts only after
/// its splash is shown to have loaded (tried twice); a stop during that wait (a close, or another restart) goes back
/// to `next_round`, which ends the loop when the app is closing.
fn run_rounds(shutdown: &Shutdown, runs: &mut impl Runs) {
    let mut ask = false;
    'runs: loop {
        runs.run(ask);
        loop {
            let Some((stop, how)) = shutdown.next_round() else { break 'runs };
            runs.set_stop(stop);
            ask = how == Restart::Choose;
            if runs.fresh_start() || (!runs.stopped() && runs.fresh_start()) {
                break;
            }
            if !runs.stopped() {
                runs.give_up();
            }
        }
    }
}

struct AppRuns {
    ui: Ui,
    app_dir: PathBuf,
    data: PathBuf,
    team: Option<String>,
    build: BuildInfo,
}

impl Runs for AppRuns {
    fn run(&mut self, ask: bool) {
        supervise(&self.ui, &self.app_dir, &self.data, self.team.as_deref(), &self.build, ask);
    }
    fn set_stop(&mut self, stop: Receiver<()>) {
        self.ui.stop = stop;
    }
    fn stopped(&self) -> bool {
        stop_requested(&self.ui.stop)
    }
    fn fresh_start(&mut self) -> bool {
        self.ui.fresh_start()
    }
    fn give_up(&mut self) {
        shell::dlog("restart: the splash could not be shown, not starting");
        let log_path = self.data.join("logs").join("server.log");
        let detail = "Questlog could not restart its window. Close Questlog and start it again.";
        self.ui.page(&pages::error_page("Questlog could not restart", detail, &log_path, &[]), Showing::Busy);
        self.ui.wait_for_stop();
    }
}

/// Runs `shell::exit_clean` when dropped (every return from `supervise`, all of which come after a stop request).
/// After a panic in the supervisor the hook has already noted the crash, so the marker stays.
struct ExitClean;

impl Drop for ExitClean {
    fn drop(&mut self) {
        shell::exit_clean();
    }
}

/// Whether a server that never became ready counts as a crash (marker kept, report offered next time). Exit code 3
/// (database from a newer Questlog) is a known refusal and a timeout is a hang or a slow machine: neither is a
/// crash. Any other exit while starting is.
fn start_error_is_crash(err: &StartError) -> bool {
    match err {
        StartError::Exited { code: Some(3), .. } => false,
        StartError::Exited { .. } => true,
        StartError::Timeout { .. } => false,
    }
}

/// Spawns the local server (Linux ties its lifetime to this thread via PR_SET_PDEATHSIG), waits for it, watches
/// it, and stops it when asked.
/// `team`: `JATIFY_TEAM` as read at start; the server is told the team address this app knows (a typed server first, as
/// the Workspace menu has it), for the Suggestion button.
fn run_local(ui: &Ui, app_dir: &Path, data: &Path, team: Option<&str>, log_path: &Path) {
    let port = match shell::choose_port(data) {
        Ok(p) => p,
        Err(e) => {
            let detail = format!("Questlog could not use its data folder {}: {e}", data.display());
            shell::dlog(&format!("error page: {detail}"));
            ui.page(&pages::error_page("Questlog could not start", &detail, log_path, &[]), Showing::Busy);
            return ui.wait_for_stop();
        }
    };
    let team_address = shell::team_address(DesktopConfig::load(data).as_ref(), team);
    let signin = supervise::signin_secret();
    let mut server = match Server::spawn(app_dir, data, port, team_address.as_ref(), &signin) {
        Ok(s) => s,
        Err(e) => {
            shell::dlog(&format!("server spawn failed: {e}"));
            ui.page(&pages::spawn_error_page(&e, app_dir, log_path), Showing::Busy);
            return ui.wait_for_stop();
        }
    };

    shell::dlog(&format!("server spawned, port {port}"));
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
        Ok(port) => {
            shell::dlog(&format!("server ready on port {port}"));
            // Signs the owner in without a password, then lands on the app (server/app.ts, /desktop-sign-in).
            match format!("http://127.0.0.1:{port}/desktop-sign-in?t={signin}").parse() {
                Ok(url) => ui.open_app(&url),
                Err(e) => eprintln!("questlog: bad app url: {e}"),
            }
        }
        Err(e) => {
            shell::dlog(&match &e {
                StartError::Exited { code, .. } => format!("server did not start: exited, code {code:?}"),
                StartError::Timeout { .. } => "server did not start: timed out".to_string(),
            });
            if start_error_is_crash(&e) && !signals::signalled() {
                shell::note_crash("the local server stopped while starting");
            }
            ui.page(&pages::start_error_page(&e, data, log_path), Showing::Busy);
            server.stop(STOP_GRACE); // after a timeout it may still be running
            return ui.wait_for_stop();
        }
    }

    // Watch the running server until the app stops.
    while let Err(RecvTimeoutError::Timeout) = ui.stop.recv_timeout(POLL) {
        if let Some(code) = server.exited() {
            if signals::signalled() {
                // The same SIGTERM reached the server (systemd's default KillMode): the app is stopping, not a crash.
                shell::dlog(&format!("server stopped by the signal, code {code:?}"));
                ui.wait_for_stop();
                break;
            }
            shell::dlog(&format!("server exited unexpectedly, code {code:?}"));
            shell::note_crash("the local server exited unexpectedly");
            ui.page(&pages::stopped_page(code, log_path, &server.tail()), Showing::Busy);
            ui.wait_for_stop();
            break;
        }
    }
    shell::dlog("stopping server");
    server.stop(STOP_GRACE);
}

/// Where the strip and the page go in a window's client area of `width` × `height` physical pixels at `scale`: the
/// strip's width, then the page's x and width. The strip never takes more than the window has.
fn split(width: u32, scale: f64) -> (u32, u32) {
    let strip = ((strip::STRIP_WIDTH * scale).round() as u32).min(width);
    (strip, width - strip)
}

/// Puts the strip at the window's left and the page beside it. On Linux GTK does it (`dock`); elsewhere the two
/// child webviews are placed by hand, again on every resize.
fn relayout(window: &Window, strip_view: &Webview, view: &Webview) {
    if cfg!(target_os = "linux") {
        return;
    }
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
    let (strip_w, view_w) = split(size.width, scale);
    let _ = strip_view.set_position(tauri::PhysicalPosition::new(0, 0));
    let _ = strip_view.set_size(tauri::PhysicalSize::new(strip_w, size.height));
    let _ = view.set_position(tauri::PhysicalPosition::new(strip_w as i32, 0));
    let _ = view.set_size(tauri::PhysicalSize::new(view_w, size.height));
}

/// Docks the strip at the window's left. On Linux, Tauri packs child webviews into the window's vertical box, one
/// above the other, and ignores their bounds: the two are moved into a horizontal row instead, the strip at its
/// fixed width. When that cannot be done the strip is hidden (the Workspace menu still switches).
///
/// Should a later Tauri honour child webview bounds on Linux (e.g. by packing them into a `GtkFixed`), the type
/// filter below finds no WebKit widgets in the box and the strip is hidden: switch Linux to `relayout` then.
#[cfg(target_os = "linux")]
fn dock(window: &Window, strip_view: &Webview, _view: &Webview) -> bool {
    use gtk::prelude::*;
    let docked = (|| -> Result<(), String> {
        let vbox = window.default_vbox().map_err(|e| e.to_string())?;
        let views: Vec<gtk::Widget> =
            vbox.children().into_iter().filter(|w| w.type_().name() == "WebKitWebView").collect();
        // Added in this order: the page, then the strip.
        let [page, strip_w] = views.as_slice() else {
            return Err(format!("{} webviews in the window", views.len()));
        };
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        vbox.remove(page);
        vbox.remove(strip_w);
        strip_w.set_size_request(strip::STRIP_WIDTH as i32, -1);
        // Nothing can be dropped on the strip: a link dragged from the server's page must not navigate it.
        strip_w.drag_dest_unset();
        row.pack_start(strip_w, false, false, 0);
        row.pack_start(page, true, true, 0);
        vbox.pack_start(&row, true, true, 0);
        row.show_all();
        Ok(())
    })();
    match docked {
        Ok(()) => true,
        Err(e) => {
            // scripts/smoke-desktop.sh fails on this line.
            eprintln!("questlog: could not dock the workspace strip: {e}");
            let _ = strip_view.hide();
            false
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn dock(window: &Window, strip_view: &Webview, view: &Webview) -> bool {
    relayout(window, strip_view, view);
    true
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
    // desktop.log is opened by the supervisor once it holds the data folder's lock; panics before that go to stderr.
    shell::install_panic_hook();
    // Read once; never written.
    let team = std::env::var("JATIFY_TEAM").ok();
    let memory_max = report::memory_max_from_env(std::env::var("JATIFY_MEMORY_MAX").ok().as_deref());
    let gate: Gate = Arc::new(Mutex::new(NavGate::new()));
    let (action_tx, action_rx) = mpsc::channel::<ShellAction>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let (load_tx, load_rx) = mpsc::sync_channel::<Url>(8);
    let shutdown = Arc::new(Shutdown {
        rounds: Mutex::new(Rounds { stop: Some(stop_tx), restart: None, quitting: false }),
        done: Mutex::new(Some(done_rx)),
    });

    let app = tauri::Builder::default()
        // Registered first, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| {
            if let Some(ws) = app.try_state::<Arc<Workspace>>() {
                on_menu(&ws, event.id().as_ref());
            }
        })
        .setup({
            let gate = gate.clone();
            let shutdown = shutdown.clone();
            move |app| {
                let splash: Url = pages::data_url(&pages::splash()).parse()?;
                let nav_app = app.handle().clone();
                let nav_gate = gate.clone();
                let popup_app = app.handle().clone();
                let (menu, items) = workspace_menu(app.handle())?;
                let window = WindowBuilder::new(app, "main")
                    .title("Questlog")
                    .menu(menu)
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(640.0, 480.0)
                    .center()
                    .build()?;
                // The server's UI and the shell's pages. No Tauri permissions (capabilities/default.json).
                let view_builder = WebviewBuilder::new("app", WebviewUrl::External(splash))
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
                    .on_page_load(move |_view, payload| {
                        // Started is the commit (the new document replaced the old one) on WebKitGTK and WebView2.
                        // Read only by a restart; a full channel just drops the URL.
                        if matches!(payload.event(), PageLoadEvent::Started | PageLoadEvent::Finished) {
                            let _ = load_tx.try_send(payload.url().clone());
                        }
                    })
                    .on_new_window(move |url, _features| {
                        // target=_blank and window.open: in-app files and outside links open in the browser. The
                        // shell's and the strip's addresses are not links to open.
                        let shell_url = url.host_str() == Some(SHELL_HOST) || strip::is_strip_host(&url);
                        if matches!(url.scheme(), "http" | "https" | "mailto") && !shell_url {
                            open_external(&popup_app, &url);
                        }
                        NewWindowResponse::Deny
                    });
                let size = LogicalSize::new(1280.0 - strip::STRIP_WIDTH, 800.0);
                let view = window.add_child(view_builder, LogicalPosition::new(strip::STRIP_WIDTH, 0.0), size)?;

                // The workspace strip: only the shell's own strip page, its clicks handled here (`on_strip`).
                let strip_gate = Arc::new(Mutex::new(StripGate::default()));
                let first = strip::page(&shell::known_servers(DesktopConfig::load(&data).as_ref(), team.as_deref()),
                    &Current::Nothing, true);
                let first_url = page_url(&first).ok_or("bad strip url")?;
                *strip_gate.lock().unwrap_or_else(|p| p.into_inner()) =
                    StripGate { expected: Some(first_url.clone()), html: first };
                let strip_nav = strip_gate.clone();
                let strip_app = app.handle().clone();
                let strip_builder = WebviewBuilder::new("strip", WebviewUrl::External(first_url))
                    .on_navigation(move |url| {
                        let nav = strip_nav.lock().unwrap_or_else(|p| p.into_inner()).decide(url);
                        match nav {
                            StripNav::Allow => true,
                            StripNav::Block => false,
                            StripNav::Act(action) => {
                                // Posted from another thread, so it runs once this navigation callback has returned.
                                let app = strip_app.clone();
                                thread::spawn(move || {
                                    let main = app.clone();
                                    let _ = main.run_on_main_thread(move || {
                                        if let Some(ws) = app.try_state::<Arc<Workspace>>() {
                                            on_strip(&ws, action);
                                        }
                                    });
                                });
                                false
                            }
                        }
                    })
                    .on_new_window(|_url, _features| NewWindowResponse::Deny);
                let strip_view = window.add_child(
                    strip_builder,
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(strip::STRIP_WIDTH, 800.0),
                )?;
                let docked = dock(&window, &strip_view, &view);
                if !docked {
                    let _ = items.strip.set_enabled(false);
                }

                let workspace = Arc::new(Workspace {
                    active: Mutex::new(Active::Off),
                    serving: Mutex::new(None),
                    menu: items,
                    window: window.clone(),
                    view: view.clone(),
                    strip: strip_view,
                    strip_gate,
                    docked,
                    data: data.clone(),
                    team: team.clone(),
                    gate: gate.clone(),
                    shutdown: shutdown.clone(),
                });
                workspace.sync();
                app.manage(workspace.clone());

                let close_shutdown = shutdown.clone();
                let close_window = window.clone();
                let layout_ws = workspace.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { .. } => {
                        // Hidden first, so the wait for the server is not a frozen ("Not responding") window.
                        let _ = close_window.hide();
                        close_shutdown.run();
                    }
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                        relayout(&layout_ws.window, &layout_ws.strip, &layout_ws.view);
                    }
                    _ => {}
                });

                // SIGTERM/SIGINT/SIGHUP: the same path as closing the window (CloseRequested: hide, Shutdown::run).
                #[cfg(unix)]
                {
                    let signal_app = app.handle().clone();
                    let watched = signals::watch(move |sig| {
                        let main = signal_app.clone();
                        let _ = main.run_on_main_thread(move || {
                            shell::dlog(&format!("signal {sig}: closing"));
                            match signal_app.get_window("main") {
                                Some(w) => {
                                    if w.close().is_err() {
                                        signal_app.exit(0);
                                    }
                                }
                                None => signal_app.exit(0),
                            }
                        });
                    });
                    if let Err(e) = watched {
                        eprintln!("questlog: could not watch for stop signals: {e}");
                    }
                }

                let data = data.clone();
                let supervise_shutdown = shutdown.clone();
                let build = BuildInfo { version: app.package_info().version.to_string(), memory_max };
                thread::Builder::new().name("supervisor".into()).spawn(move || {
                    let ui = Ui { window, view, gate, stop: stop_rx, actions: action_rx, workspace, loads: load_rx };
                    let mut runs = AppRuns { ui, app_dir: app_dir(), data, team, build };
                    run_rounds(&supervise_shutdown, &mut runs);
                    drop(done_tx);
                })?;
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start Questlog");

    app.run(move |_app, event| {
        if ends_run(&event) {
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
        NavGate { showing, ..NavGate::new() }
    }

    /// The server's UI at http://nas:8780 showing.
    fn app_gate() -> NavGate {
        NavGate { allowed: Some("http://nas:8780/".parse().unwrap()), showing: Showing::App, expected: None }
    }

    #[test]
    fn server_ui_cannot_load_foreign_shell_lookalikes() {
        let own = page_url(&pages::splash()).unwrap();
        let mut g = app_gate();
        g.expected = Some(own.clone());
        // A data: page that is not the one the shell asked for, even the same splash with another nonce.
        let foreign: Url = "data:text/html,<h1>Where is your workspace?</h1>".parse().unwrap();
        assert_eq!(g.decide(&foreign), Nav::Block);
        assert_eq!(g.decide(&page_url(&pages::splash()).unwrap()), Nav::Block);
        assert_eq!(g.decide(&"about:blank".parse().unwrap()), Nav::Block);
        // The shell's own page goes through.
        assert_eq!(g.decide(&own), Nav::Allow);
        // Nothing expected: no data: page at all.
        let mut g = app_gate();
        assert_eq!(g.decide(&own), Nav::Block);
        // Shell pages still navigate between data: pages as before.
        assert_eq!(gate(Showing::Busy).decide(&foreign), Nav::Allow);
    }

    #[test]
    fn page_urls_are_one_time() {
        let a = page_url(&pages::splash()).unwrap();
        let b = page_url(&pages::splash()).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.scheme(), "data");
        assert_eq!(a.fragment(), None, "the nonce is in the document, so a new showing is a new load");
    }

    #[test]
    fn splash_wait_takes_only_its_own_url() {
        let want = page_url(&pages::splash()).unwrap();
        let (_stop_tx, stop) = mpsc::channel::<()>();
        // Other pages, another data: URL, the same splash with another nonce: not it, then the timeout.
        let (tx, loads) = mpsc::channel();
        tx.send("http://nas:8780/".parse().unwrap()).unwrap();
        tx.send("data:text/html,splash".parse().unwrap()).unwrap();
        tx.send(page_url(&pages::splash()).unwrap()).unwrap();
        assert_eq!(wait_for_page(&loads, &want, &stop, Duration::from_millis(300)), Waited::TimedOut);
        // Its own URL.
        tx.send("data:text/html,x".parse().unwrap()).unwrap();
        tx.send(want.clone()).unwrap();
        assert_eq!(wait_for_page(&loads, &want, &stop, Duration::from_secs(2)), Waited::Loaded);
        // Nothing at all (a cancelled load reports nothing): the timeout.
        assert_eq!(wait_for_page(&loads, &want, &stop, Duration::from_millis(300)), Waited::TimedOut);
        // A stop ends the wait.
        let (stop_tx, stop) = mpsc::channel::<()>();
        drop(stop_tx);
        tx.send(want.clone()).unwrap();
        assert_eq!(wait_for_page(&loads, &want, &stop, Duration::from_secs(2)), Waited::Stopped);
    }

    /// Scripted runs for `run_rounds`.
    struct FakeRuns<'a> {
        shutdown: &'a Shutdown,
        stop: Option<Receiver<()>>,
        log: Vec<String>,
        /// What each fresh_start does, in order: Ok(shown) or Err(()) for "a restart arrives meanwhile".
        fresh: Vec<Result<bool, ()>>,
        /// Restart asked for during the n-th run (by index), else the run ends with a close.
        restart_in_run: Vec<Option<Restart>>,
        runs: usize,
    }

    impl Runs for FakeRuns<'_> {
        fn run(&mut self, ask: bool) {
            self.log.push(format!("run ask={ask}"));
            let what = self.restart_in_run.get(self.runs).copied().flatten();
            self.runs += 1;
            match what {
                Some(how) => assert!(self.shutdown.restart(how)),
                None => self.shutdown.run(),
            }
        }
        fn set_stop(&mut self, stop: Receiver<()>) {
            self.stop = Some(stop);
        }
        fn stopped(&self) -> bool {
            self.stop.as_ref().is_none_or(stop_requested)
        }
        fn fresh_start(&mut self) -> bool {
            let r = if self.fresh.is_empty() { Ok(true) } else { self.fresh.remove(0) };
            match r {
                Ok(shown) => {
                    self.log.push(format!("fresh {shown}"));
                    shown
                }
                Err(()) => {
                    self.log.push("fresh: restarted meanwhile".into());
                    assert!(self.shutdown.restart(Restart::Saved));
                    false
                }
            }
        }
        fn give_up(&mut self) {
            self.log.push("give up".into());
            self.shutdown.run();
        }
    }

    fn fake_shutdown() -> Shutdown {
        let (tx, _rx) = mpsc::channel::<()>();
        let rounds = Rounds { stop: Some(tx), restart: None, quitting: false };
        Shutdown { rounds: Mutex::new(rounds), done: Mutex::new(None) }
    }

    fn fake<'a>(sd: &'a Shutdown, fresh: Vec<Result<bool, ()>>, restarts: Vec<Option<Restart>>) -> FakeRuns<'a> {
        FakeRuns { shutdown: sd, stop: None, log: vec![], fresh, restart_in_run: restarts, runs: 0 }
    }

    #[test]
    fn restart_during_fresh_start_goes_back_to_next_round() {
        let sd = fake_shutdown();
        let mut r = fake(&sd, vec![Err(()), Ok(true)], vec![Some(Restart::Choose), None]);
        run_rounds(&sd, &mut r);
        // The second restart (Saved) replaces the first: the run starts from the saved choice.
        assert_eq!(r.log, ["run ask=false", "fresh: restarted meanwhile", "fresh true", "run ask=false"]);
    }

    #[test]
    fn a_splash_that_does_not_load_is_retried_once_then_no_run() {
        let sd = fake_shutdown();
        let mut r = fake(&sd, vec![Ok(false), Ok(true)], vec![Some(Restart::Choose), None]);
        run_rounds(&sd, &mut r);
        assert_eq!(r.log, ["run ask=false", "fresh false", "fresh true", "run ask=true"]);

        let sd = fake_shutdown();
        let mut r = fake(&sd, vec![Ok(false), Ok(false)], vec![Some(Restart::Saved)]);
        run_rounds(&sd, &mut r);
        assert_eq!(r.log, ["run ask=false", "fresh false", "fresh false", "give up"], "no run without the splash");
    }

    #[test]
    fn a_close_ends_the_rounds() {
        let sd = fake_shutdown();
        let mut r = fake(&sd, vec![], vec![None]);
        run_rounds(&sd, &mut r);
        assert_eq!(r.log, ["run ask=false"]);
    }

    #[test]
    fn start_errors_that_are_crashes() {
        let exited = |code| StartError::Exited { code, tail: vec![] };
        assert!(!start_error_is_crash(&exited(Some(3))), "newer database");
        assert!(start_error_is_crash(&exited(Some(1))));
        assert!(start_error_is_crash(&exited(None)), "killed by a signal");
        assert!(!start_error_is_crash(&StartError::Timeout { tail: vec![] }));
    }

    #[test]
    fn exit_event_ends_the_run() {
        assert!(ends_run(&RunEvent::Exit));
        assert!(!ends_run(&RunEvent::Ready));
    }

    #[test]
    fn shell_actions_only_from_shell_pages() {
        let local = "http://questlog-shell.invalid/local".parse::<Url>().unwrap();
        let server = "http://questlog-shell.invalid/server?address=evil".parse::<Url>().unwrap();
        // The server's UI (local or remote) cannot switch servers or turn on local mode.
        let mut g = app_gate();
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
        let mut g = app_gate();
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

    #[test]
    fn menu_ids_map_to_actions() {
        assert_eq!(menu_action(MENU_TEAM), Some(MenuAction::UseTeam));
        assert_eq!(menu_action(MENU_LOCAL), Some(MenuAction::UseLocal));
        assert_eq!(menu_action(MENU_CHANGE), Some(MenuAction::Change));
        assert_eq!(menu_action(MENU_STRIP), Some(MenuAction::FocusStrip));
        for other in ["", "local", "questlog-shell.invalid/local", "http://questlog-shell.invalid/local", "quit"] {
            assert_eq!(menu_action(other), None, "{other}");
        }
    }

    #[test]
    fn menu_moves() {
        use MenuAction::*;
        let team = Active::Working(Mode::Team);
        let local = Active::Working(Mode::Local);
        // The mode already active is a no-op.
        assert_eq!(menu_move(UseTeam, team, true), MenuMove::Nothing);
        assert_eq!(menu_move(UseLocal, local, true), MenuMove::Nothing);
        assert_eq!(menu_move(Change, Active::Choosing, true), MenuMove::Nothing);
        // Switching.
        assert_eq!(menu_move(UseLocal, team, true), MenuMove::Switch(Mode::Local));
        assert_eq!(menu_move(UseTeam, local, true), MenuMove::Switch(Mode::Team));
        assert_eq!(menu_move(UseLocal, Active::Choosing, false), MenuMove::Switch(Mode::Local));
        assert_eq!(menu_move(UseTeam, Active::Choosing, true), MenuMove::Switch(Mode::Team));
        assert_eq!(menu_move(Change, team, true), MenuMove::Choose);
        assert_eq!(menu_move(Change, local, false), MenuMove::Choose);
        // No team address: the team item does nothing.
        assert_eq!(menu_move(UseTeam, local, false), MenuMove::Nothing);
        // Before the supervisor has started (or in a second instance, or while restarting): nothing at all.
        for a in [UseTeam, UseLocal, Change] {
            assert_eq!(menu_move(a, Active::Off, true), MenuMove::Nothing);
        }
        // Going to the strip is only a focus move: always.
        for active in [Active::Off, Active::Choosing, team, local] {
            assert_eq!(menu_move(FocusStrip, active, false), MenuMove::FocusStrip);
        }
    }

    #[test]
    fn strip_moves() {
        let nas: Url = "http://nas:8780/".parse().unwrap();
        let other: Url = "http://other:9/".parse().unwrap();
        let known = [nas.clone(), other.clone()];
        let team = Active::Working(Mode::Team);
        let local = Active::Working(Mode::Local);
        let server = |s: &str| StripAction::Server(s.into());
        // This computer.
        assert_eq!(strip_move(&StripAction::Local, team, Some(&nas), &known), StripMove::Local);
        assert_eq!(strip_move(&StripAction::Local, Active::Choosing, None, &known), StripMove::Local);
        assert_eq!(strip_move(&StripAction::Local, local, None, &known), StripMove::Nothing);
        // A known team server, written as the page has it.
        assert_eq!(strip_move(&server("http://nas:8780/"), local, None, &known), StripMove::Server(nas.clone()));
        assert_eq!(strip_move(&server("http://other:9"), team, Some(&nas), &known), StripMove::Server(other.clone()));
        assert_eq!(strip_move(&server("http://nas:8780/"), Active::Choosing, None, &known), StripMove::Server(nas.clone()));
        // The one already open: nothing.
        assert_eq!(strip_move(&server("http://nas:8780/"), team, Some(&nas), &known), StripMove::Nothing);
        // Any address that is not a known server: nothing (the strip never takes one in).
        for bad in ["http://evil:8780/", "nas", "javascript:alert(1)", "", "local", "ftp://nas:8780/"] {
            assert_eq!(strip_move(&server(bad), local, None, &known), StripMove::Nothing, "{bad}");
        }
        assert_eq!(strip_move(&server("http://nas:8780/"), local, None, &[]), StripMove::Nothing);
        // "+".
        assert_eq!(strip_move(&StripAction::Choose, team, Some(&nas), &known), StripMove::Choose);
        assert_eq!(strip_move(&StripAction::Choose, local, None, &known), StripMove::Choose);
        assert_eq!(strip_move(&StripAction::Choose, Active::Choosing, None, &known), StripMove::Nothing);
        // Starting, restarting, a second instance: no switch at all; Esc still goes back to the page.
        for a in [StripAction::Local, server("http://other:9/"), StripAction::Choose] {
            assert_eq!(strip_move(&a, Active::Off, None, &known), StripMove::Nothing, "{a:?}");
        }
        assert_eq!(strip_move(&StripAction::App, Active::Off, None, &known), StripMove::FocusApp);
    }

    #[test]
    fn strip_highlight_follows_the_supervisor() {
        let nas: Url = "http://nas:8780/".parse().unwrap();
        assert_eq!(current_of(Active::Off, Some(&nas)), Current::Nothing);
        assert_eq!(current_of(Active::Choosing, None), Current::Choosing);
        assert_eq!(current_of(Active::Working(Mode::Local), Some(&nas)), Current::Local);
        assert_eq!(current_of(Active::Working(Mode::Team), Some(&nas)), Current::Team(nas));
        assert_eq!(current_of(Active::Working(Mode::Team), None), Current::Nothing);
    }

    #[test]
    fn server_pages_cannot_reach_the_strip() {
        // Whatever the page showing (shell page, busy, the server's UI), strip addresses are blocked: not acted on,
        // not opened in the browser.
        for showing in [Showing::App, Showing::ShellPage, Showing::Busy] {
            for u in [
                "http://questlog-strip.invalid/local",
                "http://questlog-strip.invalid/server?url=http%3A%2F%2Fevil%3A8780%2F",
                "http://questlog-strip.invalid/choose",
                "https://questlog-strip.invalid/local",
                "http://QUESTLOG-STRIP.invalid/app",
            ] {
                let mut g = NavGate { showing, ..app_gate() };
                assert_eq!(g.decide(&u.parse().unwrap()), Nav::Block, "{u} {showing:?}");
                assert_eq!(g.showing, showing, "a blocked strip address does not close the gate");
            }
        }
    }

    #[test]
    fn strip_and_page_share_the_width() {
        assert_eq!(split(1280, 1.0), (56, 1224));
        assert_eq!(split(2560, 2.0), (112, 2448));
        assert_eq!(split(1920, 1.25), (70, 1850));
        assert_eq!(split(40, 1.0), (40, 0));
    }

    #[test]
    fn restart_starts_a_new_run_until_the_app_closes() {
        let (tx, first) = mpsc::channel::<()>();
        let sd = Shutdown {
            rounds: Mutex::new(Rounds { stop: Some(tx), restart: None, quitting: false }),
            done: Mutex::new(None),
        };
        // A run that ends without a restart asked for is the last.
        assert!(sd.next_round().is_none());
        assert!(!stop_requested(&first));
        assert!(sd.restart(Restart::Choose));
        assert!(stop_requested(&first), "the current run is told to stop");
        let (second, how) = sd.next_round().expect("a new run");
        assert_eq!(how, Restart::Choose);
        assert!(!stop_requested(&second));
        assert!(sd.next_round().is_none(), "one restart, one new run");
        // Closing stops the run and ends the rounds; a switch after that is dropped.
        sd.run();
        assert!(stop_requested(&second));
        assert!(!sd.restart(Restart::Saved));
        assert!(sd.next_round().is_none());
    }

    #[test]
    fn a_close_during_a_restart_wins() {
        let (tx, _first) = mpsc::channel::<()>();
        let sd = Shutdown {
            rounds: Mutex::new(Rounds { stop: Some(tx), restart: None, quitting: false }),
            done: Mutex::new(None),
        };
        assert!(sd.restart(Restart::Saved));
        sd.run();
        assert!(sd.next_round().is_none());
    }

    #[test]
    fn targets_to_menu_state() {
        assert_eq!(active_for(&Target::Local), Active::Working(Mode::Local));
        assert_eq!(active_for(&Target::Server("http://nas:8780/".parse().unwrap())), Active::Working(Mode::Team));
        assert_eq!(active_for(&Target::Ask), Active::Choosing);
    }

    #[test]
    fn crash_actions_only_from_shell_pages() {
        for (path, action) in [
            ("crash-send", ShellAction::CrashSend),
            ("crash-skip", ShellAction::CrashSkip),
            ("crash-view", ShellAction::CrashView),
            ("crash-back", ShellAction::CrashBack),
            ("continue", ShellAction::Continue),
        ] {
            let url: Url = format!("http://questlog-shell.invalid/{path}").parse().unwrap();
            let mut g = app_gate();
            assert_eq!(g.decide(&url), Nav::Block, "{path}");
            assert_eq!(gate(Showing::Busy).decide(&url), Nav::Block, "{path}");
            let mut g = gate(Showing::ShellPage);
            assert_eq!(g.decide(&url), Nav::Shell(action), "{path}");
            assert_eq!(g.decide(&url), Nav::Block, "{path}: one action per page");
        }
    }

    #[test]
    fn crash_pages_take_only_their_own_actions() {
        use CrashMove::*;
        use CrashPage::*;
        assert_eq!(crash_move(Prompt, &ShellAction::CrashSend), Send);
        assert_eq!(crash_move(Prompt, &ShellAction::CrashSkip), Start);
        assert_eq!(crash_move(Prompt, &ShellAction::CrashView), Show(Details));
        assert_eq!(crash_move(Details, &ShellAction::CrashBack), Show(Prompt));
        assert_eq!(crash_move(Result, &ShellAction::Continue), Start);
        assert_eq!(crash_move(Prompt, &ShellAction::Continue), Stay);
        assert_eq!(crash_move(Prompt, &ShellAction::Local), Stay);
        assert_eq!(crash_move(Details, &ShellAction::CrashSend), Stay);
        assert_eq!(crash_move(Result, &ShellAction::CrashSend), Stay);
        assert_eq!(crash_move(Result, &ShellAction::CrashBack), Stay);
        // Outside the crash flow they never start anything.
        assert_eq!(step(ShellAction::CrashSend, None), Step::Chooser(None));
        assert_eq!(step(ShellAction::Continue, None), Step::Chooser(None));
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
        assert_eq!(nav("http://questlog-shell.invalid/crash-send", 0), Nav::Shell(ShellAction::CrashSend));
        assert_eq!(nav("http://questlog-shell.invalid/continue", 0), Nav::Shell(ShellAction::Continue));
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

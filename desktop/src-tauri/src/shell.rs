use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Url;

pub const PREFERRED_PORT: u16 = 8790;
/// Lines of recent output kept in memory for error reports.
const TAIL_LINES: usize = 200;

/// Where Questlog keeps its database, files, logs and backups.
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join("AppData").join("Local")
        });
        base.join("Questlog")
    }
    #[cfg(not(windows))]
    {
        let base = match std::env::var_os("XDG_DATA_HOME") {
            Some(x) if !x.is_empty() => PathBuf::from(x),
            _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share"),
        };
        base.join("questlog")
    }
}

fn bindable(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Default port of a Questlog team server.
const TEAM_DEFAULT_PORT: u16 = 8780;

/// The `desktop.json` choices: the local server's port, where the window connects (`"local"` or a server URL), and
/// the server URL that "Use this computer" replaced (for "Use the team server" to go back to).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DesktopConfig {
    pub port: Option<u16>,
    pub server: Option<String>,
    pub last_server: Option<String>,
}

impl DesktopConfig {
    /// `None` when there is no `desktop.json`; an unreadable or invalid one counts as an empty config.
    pub fn load(data: &Path) -> Option<DesktopConfig> {
        let text = match fs::read_to_string(data.join("desktop.json")) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
            Err(_) => return Some(DesktopConfig::default()),
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            return Some(DesktopConfig::default());
        };
        let port = v.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0);
        let text = |k: &str| v.get(k).and_then(|s| s.as_str()).map(str::to_string);
        Some(DesktopConfig { port, server: text("server"), last_server: text("last_server") })
    }

    pub fn save(&self, data: &Path) -> io::Result<()> {
        let mut map = serde_json::Map::new();
        if let Some(p) = self.port {
            map.insert("port".into(), p.into());
        }
        if let Some(s) = &self.server {
            map.insert("server".into(), s.clone().into());
        }
        if let Some(s) = &self.last_server {
            map.insert("last_server".into(), s.clone().into());
        }
        let mut text = serde_json::to_string_pretty(&serde_json::Value::Object(map)).map_err(io::Error::other)?;
        text.push('\n');
        fs::write(data.join("desktop.json"), text)
    }
}

/// Parses `JATIFY_TEAM`: `host` or `host:port` (IPv6 in brackets), no scheme. Anything else is `None`.
pub fn team_url(value: &str) -> Option<Url> {
    let v = value.trim();
    if v.is_empty() || v.ends_with(':') || v.contains("://") || v.contains(|c: char| c.is_whitespace() || matches!(c, '/' | '\\' | '@' | '?' | '#')) {
        return None;
    }
    let mut url = Url::parse(&format!("http://{v}")).ok()?;
    url.host_str()?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let has_port = match v.strip_prefix('[') {
        Some(rest) => rest.contains("]:"),
        None => v.contains(':'),
    };
    if !has_port {
        url.set_port(Some(TEAM_DEFAULT_PORT)).ok()?;
    }
    Some(url)
}

/// Parses a saved server address: an http(s) URL with a host. Credentials, path, query and fragment are dropped.
pub fn saved_url(value: &str) -> Option<Url> {
    let mut url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.host_str()?;
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

/// An address typed into the chooser: a full http(s) URL, or a bare `host` / `host:port` like `JATIFY_TEAM`.
pub fn address_url(value: &str) -> Option<Url> {
    saved_url(value).or_else(|| team_url(value))
}

/// Serialises this process's read-modify-write of `desktop.json` (the supervisor and the Workspace menu).
static CONFIG_WRITE: Mutex<()> = Mutex::new(());

/// Loads `desktop.json`, lets `change` make the new config from it (`None`: no file yet), and saves the result.
pub fn update_config(
    data: &Path,
    change: impl FnOnce(Option<DesktopConfig>) -> DesktopConfig,
) -> io::Result<DesktopConfig> {
    let _guard = CONFIG_WRITE.lock().unwrap_or_else(|p| p.into_inner());
    fs::create_dir_all(data)?;
    let cfg = change(DesktopConfig::load(data));
    cfg.save(data)?;
    Ok(cfg)
}

/// Saves where the window connects (`"local"` or a server URL) in `desktop.json`, keeping the saved port.
pub fn save_server(data: &Path, value: &str) -> io::Result<()> {
    update_config(data, |cfg| DesktopConfig { server: Some(value.to_string()), ..cfg.unwrap_or_default() }).map(|_| ())
}

/// Where the window connects.
#[derive(Debug, PartialEq)]
pub enum Target {
    Local,
    Server(Url),
    Ask,
}

impl Target {
    /// For desktop.log: `Local`, `Ask` or `Server <url>`.
    pub fn log_text(&self) -> String {
        match self {
            Target::Local => "Local".to_string(),
            Target::Ask => "Ask".to_string(),
            Target::Server(url) => format!("Server {url}"),
        }
    }
}

/// A saved choice wins over `JATIFY_TEAM`; with neither and no `desktop.json` at all the user is asked.
pub fn resolve_target(cfg: Option<&DesktopConfig>, team: Option<&str>) -> Target {
    if let Some(saved) = cfg.and_then(|c| c.server.as_deref()) {
        if saved.trim() == "local" {
            return Target::Local;
        }
        if let Some(url) = saved_url(saved) {
            return Target::Server(url);
        }
    }
    if let Some(url) = team.and_then(team_url) {
        return Target::Server(url);
    }
    if cfg.is_none() {
        Target::Ask
    } else {
        Target::Local
    }
}

/// The two places to work that the Workspace menu switches between.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mode {
    Team,
    Local,
}

/// The team server the menu's "Use the team server" goes to: a saved server URL, else the one "Use this computer"
/// replaced (`last_server`), else `JATIFY_TEAM`.
pub fn team_address(cfg: Option<&DesktopConfig>, team: Option<&str>) -> Option<Url> {
    let saved = |f: fn(&DesktopConfig) -> Option<&str>| cfg.and_then(f).and_then(saved_url);
    saved(|c| c.server.as_deref()).or_else(|| saved(|c| c.last_server.as_deref())).or_else(|| team.and_then(team_url))
}

/// The `desktop.json` that makes the next start open `want`. The port is always kept.
/// - This computer: `"server": "local"`; a saved server URL moves to `last_server`.
/// - The team server: a saved server URL stays; otherwise `last_server` comes back (a typed server still wins over
///   `JATIFY_TEAM`), else the saved value is removed so `JATIFY_TEAM` applies. Without any team address the config
///   is left as it is.
pub fn switch_choice(cfg: Option<&DesktopConfig>, team: Option<&str>, want: Mode) -> DesktopConfig {
    let mut next = cfg.cloned().unwrap_or_default();
    let server_is_url = next.server.as_deref().is_some_and(|s| saved_url(s).is_some());
    match want {
        Mode::Local => {
            if server_is_url {
                next.last_server = next.server.take();
            }
            next.server = Some("local".to_string());
        }
        Mode::Team if server_is_url => {}
        Mode::Team => {
            if next.last_server.as_deref().is_some_and(|s| saved_url(s).is_some()) {
                next.server = next.last_server.take();
            } else if team.and_then(team_url).is_some() {
                next.server = None;
            }
        }
    }
    next
}

/// The window title for where the app works: the team server's host, this computer, or plain `Questlog` while it
/// asks.
pub fn title_for(target: &Target) -> String {
    match target {
        Target::Server(url) => {
            let host = url.host_str().unwrap_or("?");
            match url.port().filter(|p| *p != TEAM_DEFAULT_PORT) {
                Some(port) => format!("Questlog · Team server ({host}:{port})"),
                None => format!("Questlog · Team server ({host})"),
            }
        }
        Target::Local => "Questlog · This computer".to_string(),
        Target::Ask => "Questlog".to_string(),
    }
}

/// Saved port if still free, else 8790 if free, else an OS-assigned port. The choice is saved.
pub fn choose_port(data: &Path) -> io::Result<u16> {
    choose_port_from(data, PREFERRED_PORT)
}

fn choose_port_from(data: &Path, preferred: u16) -> io::Result<u16> {
    let mut chosen = Ok(0);
    let cfg = update_config(data, |cfg| {
        let cfg = cfg.unwrap_or_default();
        chosen = match cfg.port.filter(|p| bindable(*p)) {
            Some(p) => Ok(p),
            None if bindable(preferred) => Ok(preferred),
            None => TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()),
        };
        DesktopConfig { port: chosen.as_ref().ok().copied().or(cfg.port), ..cfg }
    })?;
    let port = chosen?;
    debug_assert_eq!(cfg.port, Some(port));
    Ok(port)
}

pub const LOCK_FILE: &str = "questlog.lock";

/// Takes the data folder's instance lock: `Ok(None)` when another Questlog holds it. The lock is held as long as
/// the returned file is open, and the OS drops it when the process dies. It backs up the single-instance plugin,
/// which lets a second launch through when it cannot reach the first (no D-Bus session bus on Linux).
pub fn lock_instance(data: &Path) -> io::Result<Option<File>> {
    fs::create_dir_all(data)?;
    let file = OpenOptions::new().create(true).truncate(false).write(true).open(data.join(LOCK_FILE))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

/// Parses the server's readiness line, `QUESTLOG_LISTENING <port>`.
pub fn parse_listening(line: &str) -> Option<u16> {
    line.trim_end().strip_prefix("QUESTLOG_LISTENING ")?.trim().parse().ok()
}

/// Line log that rotates at `max` bytes, keeping one old copy (`<name>.1`), plus an in-memory tail.
pub struct RotatingLog {
    path: PathBuf,
    max: u64,
    size: u64,
    file: File,
    tail: VecDeque<String>,
}

impl RotatingLog {
    pub fn open(path: &Path, max: u64) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(RotatingLog { path: path.to_path_buf(), max, size, file, tail: VecDeque::new() })
    }

    fn old_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push(".1");
        PathBuf::from(name)
    }

    fn rotate(&mut self) -> io::Result<()> {
        let old = self.old_path();
        let _ = fs::remove_file(&old); // rename over an existing file fails on Windows
        fs::rename(&self.path, &old)?;
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.size = 0;
        Ok(())
    }

    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        if self.tail.len() == TAIL_LINES {
            self.tail.pop_front();
        }
        self.tail.push_back(line.to_string());
        let len = line.len() as u64 + 1;
        if self.size > 0 && self.size + len > self.max && self.rotate().is_err() {
            // Rotation failed (old copy locked or in the way): keep appending, retry after another `max` bytes.
            self.size = 0;
        }
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.size += len;
        Ok(())
    }

    /// The last `n` lines written through this handle (oldest first).
    pub fn tail(&self, n: usize) -> Vec<String> {
        self.tail.iter().skip(self.tail.len().saturating_sub(n)).cloned().collect()
    }
}

/// Name of the marker file in the data folder that exists while Questlog runs. Still there at the next start
/// means the last run did not exit through its normal shutdown.
pub const RUNNING_MARKER: &str = "running";
const DESKTOP_LOG_MAX: u64 = 5 * 1024 * 1024;

/// Writes a fresh running marker. True when one was already there (the last run ended badly).
pub fn mark_running(data: &Path) -> io::Result<bool> {
    fs::create_dir_all(data)?;
    let marker = data.join(RUNNING_MARKER);
    let was = marker.exists();
    fs::write(&marker, format!("{} pid {}\n", utc_stamp(SystemTime::now()), std::process::id()))?;
    Ok(was)
}

/// Removes the running marker (a missing one is fine).
pub fn clear_running(data: &Path) {
    let _ = fs::remove_file(data.join(RUNNING_MARKER));
}

/// The data folder whose marker this process wrote; `None` until `mark_running_owned` succeeds.
static MARKED: OnceLock<PathBuf> = OnceLock::new();
/// Set by the first `exit_clean`, so the marker is handled and "exit" logged only once.
static EXITED: AtomicBool = AtomicBool::new(false);
/// Whether the previous run ended badly, as seen by `mark_running_owned`.
static LAST_RUN_ENDED_BADLY: AtomicBool = AtomicBool::new(false);
/// Set when this run crashed (a panic, or the local server dying) even though the window may still close normally.
static CRASHED: AtomicBool = AtomicBool::new(false);

/// `mark_running` for the process that holds the data-folder lock; remembers the folder so `exit_clean` clears it,
/// and the answer for `last_run_ended_badly`. Called at the start of each run of the supervisor (a Workspace menu
/// switch starts a new one in the same process): each run then exits, and counts a crash, on its own.
pub fn mark_running_owned(data: &Path) -> bool {
    EXITED.store(false, Ordering::SeqCst);
    CRASHED.store(false, Ordering::SeqCst);
    let was = match mark_running(data) {
        Ok(w) => w,
        Err(e) => {
            dlog(&format!("could not write the running marker: {e}"));
            // No marker read this run: not "ended badly", whatever an earlier run in this process saw.
            LAST_RUN_ENDED_BADLY.store(false, Ordering::SeqCst);
            return false;
        }
    };
    let _ = MARKED.set(data.to_path_buf());
    LAST_RUN_ENDED_BADLY.store(was, Ordering::SeqCst);
    was
}

/// True when the marker was already there at start: the last run crashed or was killed.
pub fn last_run_ended_badly() -> bool {
    LAST_RUN_ENDED_BADLY.load(Ordering::SeqCst)
}

/// Records that this run crashed, so the normal exit that follows (the user closing the window) keeps the marker
/// and the next start offers a crash report.
pub fn note_crash(reason: &str) {
    CRASHED.store(true, Ordering::SeqCst);
    dlog(&format!("crash: {reason}"));
}

/// Whether a normal exit removes the marker: not after a crash noted in this run.
fn should_clear_marker(crashed: bool) -> bool {
    !crashed
}

/// The normal end of the run: clears the marker this process wrote, unless this run crashed. Once only; a process
/// that never took the lock leaves the other one's marker alone.
pub fn exit_clean() {
    if let Some(data) = MARKED.get().filter(|_| !EXITED.swap(true, Ordering::SeqCst)) {
        if should_clear_marker(CRASHED.load(Ordering::SeqCst)) {
            clear_running(data);
            dlog("exit");
        } else {
            dlog("exit after a crash");
        }
    }
}

static DESKTOP_LOG: OnceLock<Mutex<RotatingLog>> = OnceLock::new();

/// Opens `logs/desktop.log` for `dlog`. Later calls and failures leave things as they are.
pub fn init_desktop_log(data: &Path) {
    if let Ok(log) = RotatingLog::open(&data.join("logs").join("desktop.log"), DESKTOP_LOG_MAX) {
        let _ = DESKTOP_LOG.set(Mutex::new(log));
    }
}

/// One line in desktop.log with a UTC timestamp. Never panics; does nothing before `init_desktop_log`.
pub fn dlog(line: &str) {
    if let Some(log) = DESKTOP_LOG.get() {
        let mut log = log.lock().unwrap_or_else(|p| p.into_inner());
        let _ = log.write_line(&format!("{} {line}", utc_stamp(SystemTime::now())));
    }
}

/// `dlog` that gives up instead of waiting for the lock: for the panic hook, which may run on a thread that
/// already holds the log (a panic inside a write).
fn dlog_try(line: &str) {
    if let Some(log) = DESKTOP_LOG.get() {
        let guard = match log.try_lock() {
            Ok(g) => Some(g),
            Err(std::sync::TryLockError::Poisoned(p)) => Some(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        };
        if let Some(mut log) = guard {
            let _ = log.write_line(&format!("{} {line}", utc_stamp(SystemTime::now())));
        }
    }
}

/// `2026-11-17T09:05:03Z`.
pub fn utc_stamp(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// What the panic hook writes: `panic: <message> at <location>` and the backtrace.
pub fn panic_text(message: &str, location: &str, backtrace: &str) -> String {
    format!("panic: {message} at {location}\n{backtrace}")
}

/// Writes panics (message, location, backtrace) to desktop.log, then runs the previous hook. Notes the crash, so
/// the marker stays even when the window is closed normally afterwards.
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(non-text payload)".into());
        let location = info.location().map(|l| l.to_string()).unwrap_or_else(|| "unknown location".into());
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        // Not `note_crash`: the hook may run on a thread that holds the log, so it only tries to write.
        CRASHED.store(true, Ordering::SeqCst);
        dlog_try(&panic_text(&message, &location, &bt));
        prev(info);
    }));
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    /// A unique scratch dir under ~/.cache/gametracker/scratch (disk, not tmpfs), removed on drop.
    pub struct Scratch(PathBuf);

    impl Scratch {
        pub fn new(name: &str) -> Scratch {
            let home = std::env::var("HOME").expect("HOME");
            let p = Path::new(&home)
                .join(".cache/gametracker/scratch")
                .join(format!("shell-{}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst), name));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::Scratch;
    use super::*;
    use std::net::TcpListener;

    fn free_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }

    fn saved_port(data: &Path) -> u16 {
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(data.join("desktop.json")).unwrap()).unwrap();
        v["port"].as_u64().unwrap() as u16
    }

    #[test]
    fn choose_port_prefers_8790_then_saves() {
        // 8790 itself may be taken on a dev machine, so exercise the preferred-port path with a free one.
        let d = Scratch::new("prefer");
        let want = free_port();
        assert_eq!(choose_port_from(d.path(), want).unwrap(), want);
        assert_eq!(saved_port(d.path()), want);
        assert_eq!(PREFERRED_PORT, 8790);
    }

    #[test]
    fn choose_port_reuses_saved() {
        let d = Scratch::new("reuse");
        let saved = free_port();
        fs::write(d.path().join("desktop.json"), format!("{{\"port\": {saved}}}")).unwrap();
        assert_eq!(choose_port_from(d.path(), free_port()).unwrap(), saved);
    }

    #[test]
    fn choose_port_moves_when_saved_is_taken() {
        let d = Scratch::new("taken");
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = held.local_addr().unwrap().port();
        fs::write(d.path().join("desktop.json"), format!("{{\"port\": {taken}}}")).unwrap();
        let got = choose_port_from(d.path(), taken).unwrap();
        assert_ne!(got, taken);
        assert_eq!(saved_port(d.path()), got);
        drop(held);
    }

    #[test]
    fn choose_port_ignores_garbage_file() {
        let d = Scratch::new("garbage");
        fs::write(d.path().join("desktop.json"), "not json").unwrap();
        let want = free_port();
        assert_eq!(choose_port_from(d.path(), want).unwrap(), want);
    }

    #[test]
    fn instance_lock_is_exclusive_until_dropped() {
        let d = Scratch::new("lock");
        let data = d.path().join("data");
        let first = lock_instance(&data).unwrap().expect("first lock");
        assert!(data.join(LOCK_FILE).exists());
        assert!(lock_instance(&data).unwrap().is_none(), "second lock taken while the first is held");
        drop(first);
        assert!(lock_instance(&data).unwrap().is_some(), "lock not free after the first handle was dropped");
    }

    #[test]
    fn parse_listening_cases() {
        assert_eq!(parse_listening("QUESTLOG_LISTENING 8790"), Some(8790));
        assert_eq!(parse_listening("QUESTLOG_LISTENING 8790\r\n"), Some(8790));
        assert_eq!(parse_listening("noise"), None);
        assert_eq!(parse_listening("QUESTLOG_LISTENING x"), None);
    }

    #[test]
    fn rotating_log_rotates_at_max_and_keeps_one() {
        let d = Scratch::new("rotate");
        let path = d.path().join("logs").join("server.log");
        let mut log = RotatingLog::open(&path, 100).unwrap();
        for i in 0..30 {
            log.write_line(&format!("line {i:03}")).unwrap(); // 9 bytes with newline, 270+ total
        }
        let mut names: Vec<String> = fs::read_dir(d.path().join("logs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["server.log", "server.log.1"]);
        assert!(fs::metadata(&path).unwrap().len() <= 100);
        assert!(fs::read_to_string(&path).unwrap().contains("line 029"));
        assert_eq!(log.tail(2), ["line 028", "line 029"]);
    }

    #[test]
    fn rotating_log_appends_to_existing_file() {
        let d = Scratch::new("append");
        let path = d.path().join("server.log");
        RotatingLog::open(&path, 1000).unwrap().write_line("one").unwrap();
        RotatingLog::open(&path, 1000).unwrap().write_line("two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
    }

    #[test]
    fn rotating_log_keeps_appending_when_rotation_fails() {
        let d = Scratch::new("norotate");
        let path = d.path().join("server.log");
        // A non-empty directory where the old copy goes: neither remove_file nor rename can replace it.
        fs::create_dir_all(d.path().join("server.log.1").join("x")).unwrap();
        let mut log = RotatingLog::open(&path, 20).unwrap();
        for i in 0..10 {
            log.write_line(&format!("line {i:03}")).unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("line 000") && text.contains("line 009"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn data_dir_honours_xdg_data_home() {
        // Only this test touches XDG_DATA_HOME.
        std::env::set_var("XDG_DATA_HOME", "/x/share");
        assert_eq!(data_dir(), PathBuf::from("/x/share/questlog"));
    }

    #[test]
    fn paths_with_spaces_and_unicode() {
        let d = Scratch::new("with space ë");
        let data = d.path().join("with space ë");
        let want = free_port();
        assert_eq!(choose_port_from(&data, want).unwrap(), want);
        let mut log = RotatingLog::open(&data.join("logs").join("server.log"), 1000).unwrap();
        log.write_line("héllo").unwrap();
        assert_eq!(fs::read_to_string(data.join("logs/server.log")).unwrap(), "héllo\n");
    }

    #[test]
    fn address_url_takes_urls_and_bare_hosts() {
        let u = |s: &str| address_url(s).map(|u| u.to_string());
        assert_eq!(u("nas").as_deref(), Some("http://nas:8780/"));
        assert_eq!(u(" 127.0.0.1:1 ").as_deref(), Some("http://127.0.0.1:1/"));
        assert_eq!(u("[::1]:9000").as_deref(), Some("http://[::1]:9000/"));
        assert_eq!(u("https://team.example.com/board?x=1").as_deref(), Some("https://team.example.com/"));
        assert_eq!(u("http://nas:8780").as_deref(), Some("http://nas:8780/"));
        assert_eq!(u(""), None);
        assert_eq!(u("ftp://nas"), None);
        assert_eq!(u("nas/path"), None);
        assert_eq!(u("two words"), None);
        assert_eq!(u("javascript:alert(1)"), None);
    }

    #[test]
    fn save_server_keeps_port() {
        let d = Scratch::new("saveserver");
        save_server(d.path(), "local").unwrap();
        assert_eq!(DesktopConfig::load(d.path()), Some(cfg(None, Some("local"))));
        DesktopConfig { port: Some(8791), server: None, last_server: None }.save(d.path()).unwrap();
        save_server(d.path(), "http://nas:8780/").unwrap();
        assert_eq!(
            DesktopConfig::load(d.path()),
            Some(DesktopConfig { port: Some(8791), server: Some("http://nas:8780/".into()), last_server: None })
        );
        // A local start afterwards keeps the saved server.
        let port = choose_port(d.path()).unwrap();
        assert_eq!(DesktopConfig::load(d.path()).unwrap().server.as_deref(), Some("http://nas:8780/"));
        assert_ne!(port, 0);
    }

    #[test]
    fn existing_install_stays_local() {
        let d = Scratch::new("existing");
        fs::write(d.path().join("desktop.json"), "{\"port\": 8790}").unwrap();
        let cfg = DesktopConfig::load(d.path());
        assert_eq!(cfg, Some(DesktopConfig { port: Some(8790), server: None, last_server: None }));
        assert_eq!(resolve_target(cfg.as_ref(), None), Target::Local);
    }

    #[test]
    fn last_server_round_trips_through_the_file() {
        let d = Scratch::new("lastserver");
        let mut c = cfg(Some(8791), Some("local"));
        c.last_server = Some("http://typed:9/".into());
        c.save(d.path()).unwrap();
        assert_eq!(DesktopConfig::load(d.path()), Some(c.clone()));
        let text = fs::read_to_string(d.path().join("desktop.json")).unwrap();
        assert!(text.contains("\"last_server\": \"http://typed:9/\""), "{text}");
        // A start in local mode keeps it.
        choose_port(d.path()).unwrap();
        assert_eq!(DesktopConfig::load(d.path()).unwrap().last_server.as_deref(), Some("http://typed:9/"));
    }

    #[test]
    fn load_cases() {
        let d = Scratch::new("load");
        assert_eq!(DesktopConfig::load(d.path()), None);
        fs::write(d.path().join("desktop.json"), "nope").unwrap();
        assert_eq!(DesktopConfig::load(d.path()), Some(DesktopConfig::default()));
    }

    #[test]
    fn saving_server_keeps_port() {
        let d = Scratch::new("saveserver");
        let want = free_port();
        fs::write(d.path().join("desktop.json"), format!("{{\"port\": {want}}}")).unwrap();
        let mut saved = DesktopConfig::load(d.path()).unwrap();
        saved.server = Some("http://nas:8780/".into());
        saved.save(d.path()).unwrap();
        let back = DesktopConfig::load(d.path()).unwrap();
        assert_eq!(back, cfg(Some(want), Some("http://nas:8780/")));
        assert_eq!(choose_port_from(d.path(), free_port()).unwrap(), want);
        assert_eq!(DesktopConfig::load(d.path()).unwrap().server.as_deref(), Some("http://nas:8780/"));
    }

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn fresh_install_asks() {
        assert_eq!(resolve_target(None, None), Target::Ask);
        assert_eq!(resolve_target(None, Some("")), Target::Ask);
        assert_eq!(resolve_target(None, Some("garbage value")), Target::Ask);
    }

    #[test]
    fn team_wins_when_nothing_saved() {
        let want = Target::Server(url("http://nas:8780/"));
        assert_eq!(resolve_target(None, Some("nas")), want);
        assert_eq!(resolve_target(Some(&DesktopConfig::default()), Some("nas")), want);
    }

    #[test]
    fn saved_local_beats_team() {
        let cfg = DesktopConfig { port: None, server: Some("local".into()), last_server: None };
        assert_eq!(resolve_target(Some(&cfg), Some("nas")), Target::Local);
    }

    #[test]
    fn saved_url_beats_team() {
        let cfg = DesktopConfig { port: Some(8790), server: Some("http://other:9/x?y#z".into()), last_server: None };
        assert_eq!(resolve_target(Some(&cfg), Some("nas")), Target::Server(url("http://other:9/")));
        let bad = DesktopConfig { port: None, server: Some("ftp://x".into()), last_server: None };
        assert_eq!(resolve_target(Some(&bad), None), Target::Local);
    }

    #[test]
    fn team_url_forms() {
        assert_eq!(team_url("100.64.0.7"), Some(url("http://100.64.0.7:8780/")));
        assert_eq!(team_url("nas:9000"), Some(url("http://nas:9000/")));
        assert_eq!(team_url("  nas  "), Some(url("http://nas:8780/")));
        assert_eq!(team_url("[fd7a:115c:a1e0::5]"), Some(url("http://[fd7a:115c:a1e0::5]:8780/")));
        assert_eq!(team_url("[fd7a:115c:a1e0::5]:9000"), Some(url("http://[fd7a:115c:a1e0::5]:9000/")));
        assert_eq!(team_url("nas:80"), Some(url("http://nas/")));
    }

    #[test]
    fn bad_team_values_are_ignored() {
        for v in ["", "  ", "http://x", "a b", "host:99999", "host/path", "host:", "u@host", "host?x", ":", "[::1"] {
            assert_eq!(team_url(v), None, "{v:?}");
        }
    }

    #[test]
    fn marker_false_first_then_true() {
        let d = Scratch::new("marker");
        assert!(!mark_running(d.path()).unwrap());
        assert!(mark_running(d.path()).unwrap());
    }

    #[test]
    fn clean_exit_leaves_no_marker() {
        let d = Scratch::new("marker-clean");
        mark_running(d.path()).unwrap();
        clear_running(d.path());
        assert!(!d.path().join(RUNNING_MARKER).exists());
        assert!(!mark_running(d.path()).unwrap());
        clear_running(d.path());
        clear_running(d.path()); // already gone
    }

    #[test]
    fn marker_is_kept_after_a_crash() {
        assert!(should_clear_marker(false));
        assert!(!should_clear_marker(true));
    }

    #[test]
    fn panic_text_has_message_and_location() {
        let t = panic_text("boom", "src/main.rs:12:5", "bt-frames");
        assert!(t.starts_with("panic: boom at src/main.rs:12:5"), "{t}");
        assert!(t.contains("bt-frames"));
    }

    #[test]
    fn dlog_try_before_init_is_a_noop() {
        dlog_try("nothing");
    }

    #[test]
    fn dlog_before_init_is_a_noop() {
        dlog("nothing"); // must not panic
    }

    #[test]
    fn utc_stamp_formats() {
        assert_eq!(utc_stamp(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(utc_stamp(UNIX_EPOCH + std::time::Duration::from_secs(1_784_278_503)), "2026-07-17T08:55:03Z");
        assert_eq!(utc_stamp(UNIX_EPOCH + std::time::Duration::from_secs(951_782_400)), "2000-02-29T00:00:00Z");
    }

    fn cfg(port: Option<u16>, server: Option<&str>) -> DesktopConfig {
        DesktopConfig { port, server: server.map(str::to_string), last_server: None }
    }

    #[test]
    fn switch_choice_for_each_start_state() {
        let nas = Some("nas");
        let starts: [Option<DesktopConfig>; 5] = [
            None,                                           // fresh install
            Some(cfg(Some(8791), None)),                    // nothing saved: JATIFY_TEAM or local
            Some(cfg(Some(8791), Some("local"))),           // saved local
            Some(cfg(Some(8791), Some("http://other:9/"))), // saved server
            Some(cfg(None, Some("ftp://bad"))),             // unusable saved value
        ];
        for start in &starts {
            for team in [nas, None] {
                let local = switch_choice(start.as_ref(), team, Mode::Local);
                assert_eq!(local.server.as_deref(), Some("local"), "{start:?} {team:?}");
                assert_eq!(local.port, start.as_ref().and_then(|c| c.port), "port kept");
                assert_eq!(resolve_target(Some(&local), team), Target::Local);
            }
        }
        // To the team server: JATIFY_TEAM applies unless a server URL is saved, which is kept.
        assert_eq!(switch_choice(None, nas, Mode::Team), cfg(None, None));
        assert_eq!(switch_choice(starts[1].as_ref(), nas, Mode::Team), cfg(Some(8791), None));
        assert_eq!(switch_choice(starts[2].as_ref(), nas, Mode::Team), cfg(Some(8791), None));
        assert_eq!(switch_choice(starts[3].as_ref(), nas, Mode::Team), cfg(Some(8791), Some("http://other:9/")));
        assert_eq!(switch_choice(starts[3].as_ref(), None, Mode::Team), cfg(Some(8791), Some("http://other:9/")));
        assert_eq!(switch_choice(starts[4].as_ref(), nas, Mode::Team), cfg(None, None));
        for start in &starts {
            let team = switch_choice(start.as_ref(), nas, Mode::Team);
            assert!(matches!(resolve_target(Some(&team), nas), Target::Server(_)), "{start:?}");
        }
        let back = switch_choice(starts[2].as_ref(), nas, Mode::Team);
        assert_eq!(resolve_target(Some(&back), nas), Target::Server(url("http://nas:8780/")));
        // A typed server goes to last_server on the way to this computer, and comes back (over JATIFY_TEAM).
        let mut moved = cfg(Some(8791), Some("local"));
        moved.last_server = Some("http://other:9/".into());
        for team in [nas, None] {
            let local = switch_choice(starts[3].as_ref(), team, Mode::Local);
            assert_eq!(local, moved, "{team:?}");
            assert_eq!(team_address(Some(&local), team), Some(url("http://other:9/")));
            let back = switch_choice(Some(&local), team, Mode::Team);
            assert_eq!(back, cfg(Some(8791), Some("http://other:9/")), "{team:?}");
            assert_eq!(resolve_target(Some(&back), team), Target::Server(url("http://other:9/")));
        }
        // A saved local or JATIFY_TEAM server is not remembered: there is nothing to remember.
        assert_eq!(switch_choice(starts[1].as_ref(), nas, Mode::Local).last_server, None);
        // No team address at all: nothing to switch to, the config stays.
        for start in &starts[..3] {
            assert_eq!(switch_choice(start.as_ref(), None, Mode::Team), start.clone().unwrap_or_default());
        }
    }

    #[test]
    fn team_address_is_saved_url_or_team() {
        assert_eq!(team_address(None, None), None);
        assert_eq!(team_address(Some(&cfg(None, Some("local"))), None), None);
        assert_eq!(team_address(Some(&cfg(None, Some("local"))), Some("nas")), Some(url("http://nas:8780/")));
        assert_eq!(team_address(Some(&cfg(None, Some("http://other:9/x"))), Some("nas")), Some(url("http://other:9/")));
        assert_eq!(team_address(None, Some("bad value")), None);
        let mut c = cfg(None, Some("local"));
        c.last_server = Some("http://typed:9/".into());
        assert_eq!(team_address(Some(&c), Some("nas")), Some(url("http://typed:9/")), "before JATIFY_TEAM");
    }

    #[test]
    fn titles_say_where_you_work() {
        assert_eq!(title_for(&Target::Server(url("http://nas:8780/"))), "Questlog · Team server (nas)");
        let t = |u: &str| title_for(&Target::Server(url(u)));
        assert_eq!(t("http://[fd7a::5]:9000/"), "Questlog · Team server ([fd7a::5]:9000)");
        assert_eq!(t("http://127.0.0.1:18781/"), "Questlog · Team server (127.0.0.1:18781)");
        assert_eq!(t("https://team.example.com/"), "Questlog · Team server (team.example.com)");
        assert_eq!(title_for(&Target::Local), "Questlog · This computer");
        assert_eq!(title_for(&Target::Ask), "Questlog");
    }

    #[test]
    fn update_config_keeps_what_it_is_not_told_to_change() {
        let d = Scratch::new("update");
        let saved = update_config(d.path(), |c| switch_choice(c.as_ref(), Some("nas"), Mode::Local)).unwrap();
        assert_eq!(saved, cfg(None, Some("local")));
        let port = choose_port_from(d.path(), free_port()).unwrap();
        assert_eq!(DesktopConfig::load(d.path()), Some(cfg(Some(port), Some("local"))));
        update_config(d.path(), |c| switch_choice(c.as_ref(), Some("nas"), Mode::Team)).unwrap();
        assert_eq!(DesktopConfig::load(d.path()), Some(cfg(Some(port), None)));
    }

    #[test]
    fn target_log_text_is_plain() {
        assert_eq!(Target::Local.log_text(), "Local");
        assert_eq!(Target::Ask.log_text(), "Ask");
        assert_eq!(Target::Server("http://127.0.0.1:8796/".parse().unwrap()).log_text(), "Server http://127.0.0.1:8796/");
    }
}

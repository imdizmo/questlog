use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

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

/// The `desktop.json` choices: the local server's port and where the window connects (`"local"` or a server URL).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DesktopConfig {
    pub port: Option<u16>,
    pub server: Option<String>,
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
        let server = v.get("server").and_then(|s| s.as_str()).map(str::to_string);
        Some(DesktopConfig { port, server })
    }

    pub fn save(&self, data: &Path) -> io::Result<()> {
        let mut map = serde_json::Map::new();
        if let Some(p) = self.port {
            map.insert("port".into(), p.into());
        }
        if let Some(s) = &self.server {
            map.insert("server".into(), s.clone().into());
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

/// Saves where the window connects (`"local"` or a server URL) in `desktop.json`, keeping the saved port.
pub fn save_server(data: &Path, value: &str) -> io::Result<()> {
    fs::create_dir_all(data)?;
    let mut cfg = DesktopConfig::load(data).unwrap_or_default();
    cfg.server = Some(value.to_string());
    cfg.save(data)
}

/// Where the window connects.
#[derive(Debug, PartialEq)]
pub enum Target {
    Local,
    Server(Url),
    Ask,
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

/// Saved port if still free, else 8790 if free, else an OS-assigned port. The choice is saved.
pub fn choose_port(data: &Path) -> io::Result<u16> {
    choose_port_from(data, PREFERRED_PORT)
}

fn choose_port_from(data: &Path, preferred: u16) -> io::Result<u16> {
    fs::create_dir_all(data)?;
    let mut cfg = DesktopConfig::load(data).unwrap_or_default();
    let port = match cfg.port.filter(|p| bindable(*p)) {
        Some(p) => p,
        None if bindable(preferred) => preferred,
        None => TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port(),
    };
    cfg.port = Some(port);
    cfg.save(data)?;
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
        assert_eq!(DesktopConfig::load(d.path()), Some(DesktopConfig { port: None, server: Some("local".into()) }));
        DesktopConfig { port: Some(8791), server: None }.save(d.path()).unwrap();
        save_server(d.path(), "http://nas:8780/").unwrap();
        assert_eq!(
            DesktopConfig::load(d.path()),
            Some(DesktopConfig { port: Some(8791), server: Some("http://nas:8780/".into()) })
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
        assert_eq!(cfg, Some(DesktopConfig { port: Some(8790), server: None }));
        assert_eq!(resolve_target(cfg.as_ref(), None), Target::Local);
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
        let mut cfg = DesktopConfig::load(d.path()).unwrap();
        cfg.server = Some("http://nas:8780/".into());
        cfg.save(d.path()).unwrap();
        let back = DesktopConfig::load(d.path()).unwrap();
        assert_eq!(back, DesktopConfig { port: Some(want), server: Some("http://nas:8780/".into()) });
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
        let cfg = DesktopConfig { port: None, server: Some("local".into()) };
        assert_eq!(resolve_target(Some(&cfg), Some("nas")), Target::Local);
    }

    #[test]
    fn saved_url_beats_team() {
        let cfg = DesktopConfig { port: Some(8790), server: Some("http://other:9/x?y#z".into()) };
        assert_eq!(resolve_target(Some(&cfg), Some("nas")), Target::Server(url("http://other:9/")));
        let bad = DesktopConfig { port: None, server: Some("ftp://x".into()) };
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
}

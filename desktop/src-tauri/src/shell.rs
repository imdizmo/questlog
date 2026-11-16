use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

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

fn read_saved(data: &Path) -> Option<u16> {
    let text = fs::read_to_string(data.join("desktop.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    u16::try_from(v.get("port")?.as_u64()?).ok().filter(|p| *p != 0)
}

/// Saved port if still free, else 8790 if free, else an OS-assigned port. The choice is saved.
pub fn choose_port(data: &Path) -> io::Result<u16> {
    choose_port_from(data, PREFERRED_PORT)
}

fn choose_port_from(data: &Path, preferred: u16) -> io::Result<u16> {
    fs::create_dir_all(data)?;
    let port = match read_saved(data).filter(|p| bindable(*p)) {
        Some(p) => p,
        None if bindable(preferred) => preferred,
        None => TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port(),
    };
    fs::write(data.join("desktop.json"), format!("{{\"port\": {port}}}\n"))?;
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
}

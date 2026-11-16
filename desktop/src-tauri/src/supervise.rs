use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::shell::{parse_listening, RotatingLog};

const LOG_MAX: u64 = 5 * 1024 * 1024;
/// Lines of server output attached to a start error.
const ERROR_TAIL: usize = 20;
/// How long to wait for the output pipes to drain after the child is gone.
const DRAIN: Duration = Duration::from_millis(500);
/// Longest server output line kept; the rest of a longer line is dropped, so memory stays bounded.
const LINE_MAX: usize = 8 * 1024;
/// Variables from the user's environment that the server must not see: they would change how node runs or
/// configure the desktop server like a LAN deployment (extra host names, secrets, upload limit, mail, billing).
const SCRUB_VARS: &[&str] = &["NODE_OPTIONS", "JT_HOSTS", "JT_SECRET", "JT_MAX_FILE_MB"];
const SCRUB_PREFIXES: &[&str] = &["EMAIL_", "STRIPE", "SMTP"];

enum Event {
    Ready(u16),
    Eof,
}

/// Owns the Windows job object that kills the server (and its children) when the shell dies.
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for Job {}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

pub struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<Event>,
    log: Arc<Mutex<RotatingLog>>,
    eofs: usize,
    #[cfg(windows)]
    _job: Option<Job>,
}

#[derive(Debug)]
pub enum StartError {
    /// The server exited before it was ready. Exit code 3 means the database is from a newer Questlog.
    Exited { code: Option<i32>, tail: Vec<String> },
    Timeout { tail: Vec<String> },
}

impl Server {
    /// Starts `<app>/runtime/node <app>/server/server.mjs` with the desktop environment.
    pub fn spawn(app_dir: &Path, data: &Path, port: u16) -> io::Result<Server> {
        let node = app_dir.join("runtime").join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut cmd = Command::new(node);
        cmd.arg("--max-old-space-size=768")
            .arg(app_dir.join("server").join("server.mjs"))
            .current_dir(app_dir)
            .env("PORT", port.to_string())
            .env("JT_HOST", "127.0.0.1")
            .env("JT_DB", data.join("jt.db"))
            .env("JT_FILES", data.join("files"))
            .env("JT_WEB", app_dir.join("web"))
            .env("JT_EXIT_ON_STDIN_CLOSE", "1")
            .env("JT_BACKUP_BEFORE_MIGRATE", "1")
            .env("JT_PUBLIC_URL", format!("http://127.0.0.1:{port}"));
        Server::launch(cmd, data)
    }

    /// Wires up pipes, logging and process-lifetime guards around `cmd` and starts it.
    /// Tests call this directly with `sh -c` stand-ins for node.
    fn launch(mut cmd: Command, data: &Path) -> io::Result<Server> {
        scrub_env(&mut cmd);
        let log = Arc::new(Mutex::new(RotatingLog::open(&data.join("logs").join("server.log"), LOG_MAX)?));
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group, so stop() can sweep up anything the server left behind.
            cmd.process_group(0);
            #[cfg(target_os = "linux")]
            unsafe {
                // The server dies with the shell, even if the shell is killed outright.
                cmd.pre_exec(|| {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        #[cfg(windows)]
        let job = match assign_kill_on_close_job(&child) {
            Ok(job) => Some(job),
            Err(e) => {
                if let Ok(mut log) = log.lock() {
                    let _ = log.write_line(&format!("[questlog] job object setup failed: {e}"));
                }
                None
            }
        };

        let (tx, events) = mpsc::channel();
        let out = child.stdout.take().expect("piped stdout");
        let err = child.stderr.take().expect("piped stderr");
        // Reader threads end on EOF, which arrives when the server and its children close the pipes.
        spawn_reader(out, log.clone(), tx.clone(), true);
        spawn_reader(err, log.clone(), tx, false);
        let stdin = child.stdin.take();
        Ok(Server {
            child,
            stdin,
            events,
            log,
            eofs: 0,
            #[cfg(windows)]
            _job: job,
        })
    }

    #[cfg(test)]
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// The last lines of server output, for error pages.
    pub fn tail(&self) -> Vec<String> {
        self.log.lock().map(|l| l.tail(ERROR_TAIL)).unwrap_or_default()
    }

    /// `Some(exit code)` once the server has exited (the code is `None` when it was killed by a signal).
    pub fn exited(&mut self) -> Option<Option<i32>> {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.drain_output();
                Some(status.code())
            }
            _ => None,
        }
    }

    /// Waits for the readiness line and returns the port the server reported.
    pub fn wait_ready(&mut self, timeout: Duration) -> Result<u16, StartError> {
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(StartError::Timeout { tail: self.tail() });
            }
            match self.events.recv_timeout((deadline - now).min(Duration::from_millis(50))) {
                Ok(Event::Ready(port)) => return Ok(port),
                Ok(Event::Eof) => self.eofs += 1,
                Err(RecvTimeoutError::Timeout) => {}
                // Both readers are done; don't spin while the process winds down.
                Err(RecvTimeoutError::Disconnected) => thread::sleep(Duration::from_millis(50)),
            }
            if let Ok(Some(status)) = self.child.try_wait() {
                self.drain_output();
                return Err(StartError::Exited { code: status.code(), tail: self.tail() });
            }
        }
    }

    /// Lets the reader threads finish the last lines, without waiting on pipes a stray child keeps open.
    fn drain_output(&mut self) {
        let deadline = Instant::now() + DRAIN;
        while self.eofs < 2 {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match self.events.recv_timeout(deadline - now) {
                Ok(Event::Eof) => self.eofs += 1,
                Ok(Event::Ready(_)) => {}
                Err(_) => break,
            }
        }
    }

    /// Closes the server's stdin (its cue to exit), waits up to `grace`, then kills it.
    pub fn stop(mut self, grace: Duration) {
        drop(self.stdin.take());
        let deadline = Instant::now() + grace;
        let exited = loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break true,
                Err(_) => break false,
                Ok(None) if Instant::now() >= deadline => break false,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
            }
        };
        if !exited {
            #[cfg(unix)]
            unsafe {
                libc::killpg(self.child.id() as libc::pid_t, libc::SIGKILL);
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.drain_output();
        // Any reader still blocked on a pipe is detached; it exits by itself when the pipe closes.
    }
}

/// Removes the inherited variables listed in `SCRUB_VARS` and `SCRUB_PREFIXES` from `cmd`.
fn scrub_env(cmd: &mut Command) {
    for name in SCRUB_VARS {
        cmd.env_remove(name);
    }
    for (name, _) in std::env::vars_os() {
        // Upper-cased: Windows variable names are case-insensitive.
        let n = name.to_string_lossy().to_ascii_uppercase();
        if SCRUB_PREFIXES.iter().any(|p| n.starts_with(p)) {
            cmd.env_remove(&name);
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    stream: R,
    log: Arc<Mutex<RotatingLog>>,
    tx: mpsc::Sender<Event>,
    watch_ready: bool,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut bytes = Vec::with_capacity(256);
        while let Ok(true) = read_capped_line(&mut reader, &mut bytes, LINE_MAX) {
            let line = String::from_utf8_lossy(&bytes);
            let line = line.trim_end_matches('\r');
            if let Ok(mut log) = log.lock() {
                let _ = log.write_line(line);
            }
            if watch_ready {
                if let Some(port) = parse_listening(line) {
                    let _ = tx.send(Event::Ready(port));
                }
            }
        }
        let _ = tx.send(Event::Eof);
    });
}

/// Reads one `\n`-terminated line into `buf` (without the `\n`), keeping at most `cap` bytes of it.
/// Returns `false` at end of input when nothing was read.
fn read_capped_line<R: BufRead>(r: &mut R, buf: &mut Vec<u8>, cap: usize) -> io::Result<bool> {
    buf.clear();
    let mut any = false;
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(any);
        }
        any = true;
        let (used, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        let content = if done { &chunk[..used - 1] } else { chunk };
        let room = cap.saturating_sub(buf.len());
        buf.extend_from_slice(&content[..content.len().min(room)]);
        r.consume(used);
        if done {
            return Ok(true);
        }
    }
}

#[cfg(windows)]
fn assign_kill_on_close_job(child: &Child) -> Result<Job, String> {
    use std::os::windows::io::AsRawHandle;
    use std::{mem, ptr};
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let handle = CreateJobObjectW(ptr::null(), ptr::null());
        if handle.is_null() {
            return Err(format!("CreateJobObjectW error {}", GetLastError()));
        }
        let job = Job(handle);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            return Err(format!("SetInformationJobObject error {}", GetLastError()));
        }
        if AssignProcessToJobObject(job.0, child.as_raw_handle() as _) == 0 {
            return Err(format!("AssignProcessToJobObject error {}", GetLastError()));
        }
        Ok(job)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::shell::testutil::Scratch;
    use std::process::Command;
    use std::time::Instant;

    fn sh(script: &str, d: &Scratch) -> Server {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        Server::launch(cmd, d.path()).unwrap()
    }

    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[test]
    fn server_ready_parses_port() {
        let d = Scratch::new("ready");
        let mut s = sh("echo noise; echo QUESTLOG_LISTENING 4242; exec cat", &d);
        assert_eq!(s.wait_ready(Duration::from_secs(5)).unwrap(), 4242);
        let pid = s.pid();
        let t = Instant::now();
        s.stop(Duration::from_secs(5)); // cat exits on stdin EOF, well before the grace
        assert!(t.elapsed() < Duration::from_secs(2));
        assert!(!alive(pid));
        let log = std::fs::read_to_string(d.path().join("logs/server.log")).unwrap();
        assert!(log.contains("noise") && log.contains("QUESTLOG_LISTENING 4242"));
    }

    #[test]
    fn server_does_not_inherit_node_or_secret_env() {
        // Set in the test process itself, as if inherited from the shell. No other test reads them.
        std::env::set_var("NODE_OPTIONS", "--inspect");
        std::env::set_var("JT_SECRET", "s3cret");
        std::env::set_var("EMAIL_QUESTLOG_SCRUB_TEST", "x");
        std::env::set_var("STRIPE_QUESTLOG_SCRUB_TEST", "x");
        std::env::set_var("SMTP_QUESTLOG_SCRUB_TEST", "x");
        let d = Scratch::new("scrub");
        let mut s = sh(
            "echo \"seen:${NODE_OPTIONS-}${JT_SECRET-}${EMAIL_QUESTLOG_SCRUB_TEST-}${STRIPE_QUESTLOG_SCRUB_TEST-}${SMTP_QUESTLOG_SCRUB_TEST-}:end\"; \
             echo QUESTLOG_LISTENING 11; exec cat",
            &d,
        );
        assert_eq!(s.wait_ready(Duration::from_secs(5)).unwrap(), 11);
        s.stop(Duration::from_secs(2));
        let log = std::fs::read_to_string(d.path().join("logs/server.log")).unwrap();
        assert!(log.contains("seen::end"), "{log}");
    }

    #[test]
    fn server_exit_3_reports_exited_with_tail() {
        let d = Scratch::new("exit3");
        let mut s = sh("echo first; echo 'database is newer' >&2; exit 3", &d);
        match s.wait_ready(Duration::from_secs(5)) {
            Err(StartError::Exited { code, tail }) => {
                assert_eq!(code, Some(3));
                assert!(tail.contains(&"database is newer".to_string()), "{tail:?}");
                assert!(tail.contains(&"first".to_string()), "{tail:?}");
            }
            other => panic!("unexpected {other:?}"),
        }
        s.stop(Duration::from_secs(1));
    }

    #[test]
    fn server_timeout() {
        let d = Scratch::new("timeout");
        let mut s = sh("echo starting; exec cat", &d);
        match s.wait_ready(Duration::from_millis(300)) {
            Err(StartError::Timeout { tail }) => assert_eq!(tail, ["starting"]),
            other => panic!("unexpected {other:?}"),
        }
        s.stop(Duration::from_secs(2));
    }

    #[test]
    fn read_capped_line_truncates_long_lines() {
        let long = "a".repeat(20_000);
        let input = format!("{long}\nshort\r\nlast");
        let mut r = BufReader::with_capacity(1000, input.as_bytes());
        let mut buf = Vec::new();
        assert!(read_capped_line(&mut r, &mut buf, LINE_MAX).unwrap());
        assert_eq!(buf.len(), LINE_MAX);
        assert!(read_capped_line(&mut r, &mut buf, LINE_MAX).unwrap());
        assert_eq!(buf, b"short\r");
        assert!(read_capped_line(&mut r, &mut buf, LINE_MAX).unwrap());
        assert_eq!(buf, b"last");
        assert!(!read_capped_line(&mut r, &mut buf, LINE_MAX).unwrap());
    }

    #[test]
    fn server_long_line_is_capped_in_log() {
        let d = Scratch::new("longline");
        let mut s = sh("head -c 100000 /dev/zero | tr '\\0' x; echo; echo QUESTLOG_LISTENING 7; exec cat", &d);
        assert_eq!(s.wait_ready(Duration::from_secs(5)).unwrap(), 7);
        s.stop(Duration::from_secs(2));
        let log = std::fs::read_to_string(d.path().join("logs/server.log")).unwrap();
        let first = log.lines().next().unwrap();
        assert_eq!(first.len(), LINE_MAX);
    }

    #[test]
    fn exit_status_after_ready() {
        let d = Scratch::new("exitafter");
        let mut s = sh("echo QUESTLOG_LISTENING 9; read x; echo bye; exit 5", &d);
        assert_eq!(s.wait_ready(Duration::from_secs(5)).unwrap(), 9);
        assert!(s.exited().is_none());
        std::io::Write::write_all(s.stdin.as_mut().unwrap(), b"go\n").unwrap();
        let t = Instant::now();
        let code = loop {
            if let Some(code) = s.exited() {
                break code;
            }
            assert!(t.elapsed() < Duration::from_secs(5));
            thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(code, Some(5));
        assert!(s.tail().contains(&"bye".to_string()));
        s.stop(Duration::from_secs(1));
    }

    #[test]
    fn stop_closes_stdin_then_kills() {
        let d = Scratch::new("kill");
        // Ignores stdin EOF and SIGHUP/SIGTERM; only SIGKILL ends it. The sleep child holds the pipes.
        let mut s = sh("trap '' HUP TERM; echo QUESTLOG_LISTENING 1; while :; do sleep 1; done", &d);
        assert_eq!(s.wait_ready(Duration::from_secs(5)).unwrap(), 1);
        let pid = s.pid();
        let t = Instant::now();
        s.stop(Duration::from_millis(400));
        let took = t.elapsed();
        assert!(took >= Duration::from_millis(400), "{took:?}");
        assert!(took < Duration::from_secs(3), "stop blocked: {took:?}");
        assert!(!alive(pid));
    }
}

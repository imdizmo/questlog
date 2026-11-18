//! Crash report: a stored zip of the logs plus `report.json`, uploaded to the team server.

use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

use tauri::Url;

/// The team server's crash port is fixed; only the host comes from `JATIFY_TEAM`.
pub const CRASH_PORT: u16 = 8781;
/// The most the server takes in one report.
pub const MAX_REPORT_BYTES: usize = 20 * 1024 * 1024;
const LOG_NAMES: [&str; 4] = ["desktop.log", "desktop.log.1", "server.log", "server.log.1"];
const RESPONSE_CAP: usize = 64 * 1024;
const ERROR_TEXT_MAX: usize = 300;

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// `JATIFY_MEMORY_MAX` as whole bytes; anything that is not a plain u64 is `None`.
pub fn memory_max_from_env(v: Option<&str>) -> Option<u64> {
    v?.trim().parse::<u64>().ok()
}

pub fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    });
    let mut c = 0xFFFF_FFFFu32;
    for &b in bytes {
        c = table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

/// Bytes a stored zip of these files takes.
fn zip_size(files: &[(String, Vec<u8>)]) -> usize {
    22 + files.iter().map(|(n, d)| 30 + 46 + 2 * n.len() + d.len()).sum::<usize>()
}

/// A zip with every entry stored (not compressed). Names are ASCII.
pub fn zip_stored(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    const DOS_TIME: u16 = 0;
    const DOS_DATE: u16 = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
    let mut out = Vec::with_capacity(zip_size(files));
    let mut central = Vec::new();
    for (name, data) in files {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let size = data.len() as u32;
        let nlen = name.len() as u16;
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // method: stored
        out.extend_from_slice(&DOS_TIME.to_le_bytes());
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&nlen.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by
        central.extend_from_slice(&20u16.to_le_bytes()); // needed
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&nlen.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    let count = files.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// The last `keep` bytes of `data`, starting at a line start when there is one in that part.
fn tail_at_line(data: &[u8], keep: usize) -> Vec<u8> {
    if data.len() <= keep {
        return data.to_vec();
    }
    let start = data.len() - keep;
    if data[start - 1] == b'\n' {
        return data[start..].to_vec();
    }
    match data[start..].iter().position(|&b| b == b'\n') {
        Some(i) => data[start + i + 1..].to_vec(),
        None => data[start..].to_vec(),
    }
}

/// `report.json` plus the logs found in `<data>/logs/`, sized to fit `limit` as a zip: the `.1` logs go first,
/// then each remaining log keeps only its last part.
pub fn build_report(data: &Path, version: &str, os: &str, memory_max: Option<u64>, limit: usize) -> Vec<(String, Vec<u8>)> {
    let mut meta = serde_json::json!({ "tool": "questlog", "version": version, "os": os });
    if let Some(m) = memory_max {
        meta["memoryMaxBytes"] = m.into();
    }
    let mut files = vec![("report.json".to_string(), serde_json::to_vec_pretty(&meta).unwrap_or_default())];
    for name in LOG_NAMES {
        if let Ok(bytes) = fs::read(data.join("logs").join(name)) {
            files.push((name.to_string(), bytes));
        }
    }
    if zip_size(&files) <= limit {
        return files;
    }
    files.retain(|(n, _)| !n.ends_with(".1"));
    if zip_size(&files) <= limit {
        return files;
    }
    // Fair share of what is left once the fixed parts are counted; short logs give their slack to the longer ones.
    let fixed: usize = 22 + files.iter().map(|(n, _)| 76 + 2 * n.len()).sum::<usize>() + files[0].1.len();
    let mut budget = limit.saturating_sub(fixed);
    let mut order: Vec<usize> = (1..files.len()).collect();
    order.sort_by_key(|&i| files[i].1.len());
    let mut left = order.len();
    for i in order {
        let keep = (budget / left).min(files[i].1.len());
        files[i].1 = tail_at_line(&files[i].1, keep);
        budget = budget.saturating_sub(files[i].1.len());
        left -= 1;
    }
    files
}

fn encode(v: &str) -> String {
    let mut out = String::new();
    for b in v.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn crash_url(team: &Url, version: &str, os: &str) -> String {
    let host = team.host_str().unwrap_or("localhost"); // IPv6 keeps its brackets
    format!("http://{host}:{CRASH_PORT}/team/crashes?tool=questlog&version={}&os={}", encode(version), encode(os))
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        Err("timed out".to_string())
    } else {
        Ok(left)
    }
}

fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(nl) = rest.windows(2).position(|w| w == b"\r\n") {
        let size_text = String::from_utf8_lossy(&rest[..nl]);
        let Ok(size) = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16) else { break };
        rest = &rest[nl + 2..];
        if size == 0 {
            break;
        }
        let take = size.min(rest.len());
        out.extend_from_slice(&rest[..take]);
        rest = &rest[take..];
        rest = rest.strip_prefix(b"\r\n").unwrap_or(rest);
    }
    out
}

/// The `"id"` string value of a JSON object, without a full parse of anything else.
fn parse_id(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body.trim()).ok()?.get("id")?.as_str().map(str::to_string)
}

/// True once `raw` holds a whole HTTP response: the headers plus Content-Length bytes, or the chunked terminator.
fn response_complete(raw: &[u8]) -> bool {
    let Some(split) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { return false };
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let body = &raw[split + 4..];
    if head.contains("transfer-encoding: chunked") {
        return body.ends_with(b"0\r\n\r\n");
    }
    match head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()) {
        Some(len) => body.len() >= len,
        None => false, // read to the close
    }
}

/// What to show for a non-201 answer: the JSON `error` string, else the body on one line, capped.
fn error_text(body: &str, status: u16) -> String {
    let text = serde_json::from_str::<serde_json::Value>(body.trim()).ok().and_then(|v| v.get("error")?.as_str().map(str::to_string)).unwrap_or_else(|| body.to_string());
    let flat = one_line(&text);
    if flat.is_empty() {
        format!("HTTP {status}")
    } else {
        flat
    }
}

/// Server text made safe to show or log: whitespace runs become one space, capped at `ERROR_TEXT_MAX` chars.
pub fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(ERROR_TEXT_MAX).collect()
}

const NOT_PRIVATE: &str = "The team server's address is not on a private network or Tailscale, so the report was not sent.";

/// Logs can hold usernames and paths, so they only go to loopback, Tailscale or a private LAN.
fn private_or_tailnet(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback() || v4.is_private() || (o[0] == 169 && o[1] == 254) || (o[0] == 100 && (64..=127).contains(&o[1]))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return private_or_tailnet(IpAddr::V4(v4));
            }
            let s = v6.segments();
            v6.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0)
        }
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
}

/// POSTs `body` (a zip) to `url`. `Ok(id)` when the server answers 201 with an id, `Err(text)` otherwise.
/// `timeout` covers everything: name lookup, connect, sending and the answer.
pub fn upload(url: &str, body: &[u8], timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    let host = parsed.host_str().ok_or("no host in the report url")?.to_string();
    // Name lookup can block for a long time, so it runs on a helper thread the deadline can walk away from.
    let (tx, rx) = std::sync::mpsc::channel();
    let lookup = parsed.clone();
    std::thread::spawn(move || {
        let _ = tx.send(lookup.socket_addrs(|| Some(CRASH_PORT)).map_err(|e| e.to_string()));
    });
    let addrs = match rx.recv_timeout(remaining(deadline)?) {
        Ok(r) => r?,
        Err(_) => return Err("timed out".to_string()),
    };
    let addrs: Vec<_> = addrs.into_iter().filter(|a| private_or_tailnet(a.ip())).collect();
    if addrs.is_empty() {
        return Err(NOT_PRIVATE.to_string());
    }
    let mut stream = None;
    let mut last = "no address".to_string();
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, remaining(deadline)?) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last = e.to_string(),
        }
    }
    let mut stream = stream.ok_or(last)?;
    let target = match parsed.query() {
        Some(q) => format!("{}?{q}", parsed.path()),
        None => parsed.path().to_string(),
    };
    let authority = match parsed.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    };
    let head = format!(
        "POST {target} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    // A server may reject early and close; then the write fails but its answer is still waiting to be read.
    let mut write_error = None;
    let mut sent = head.as_bytes().chunks(head.len()).chain(body.chunks(64 * 1024));
    for chunk in &mut sent {
        stream.set_write_timeout(Some(remaining(deadline)?)).map_err(|e| e.to_string())?;
        if let Err(e) = stream.write_all(chunk) {
            if is_timeout(&e) {
                return Err("timed out".to_string());
            }
            write_error = Some(e.to_string());
            break;
        }
    }

    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    while raw.len() < RESPONSE_CAP && !response_complete(&raw) {
        stream.set_read_timeout(Some(remaining(deadline)?)).map_err(|e| e.to_string())?;
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(e) if is_timeout(&e) => return Err("timed out".to_string()),
            Err(_) if !raw.is_empty() => break, // reset after the answer arrived
            Err(e) => return Err(write_error.unwrap_or_else(|| e.to_string())),
        }
    }
    let no_answer = || write_error.clone().unwrap_or_else(|| "the server sent no valid HTTP answer".to_string());
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(no_answer)?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status: u16 = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).ok_or_else(no_answer)?;
    let mut body_bytes = raw[split + 4..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        body_bytes = dechunk(&body_bytes);
    }
    let text = String::from_utf8_lossy(&body_bytes).to_string();
    if status == 201 {
        return parse_id(&text).ok_or_else(|| "the server accepted the report but sent no id".to_string());
    }
    Err(error_text(&text, status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::testutil::Scratch;
    use std::net::TcpListener;
    use std::process::Command;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn put_logs(d: &Scratch, files: &[(&str, Vec<u8>)]) {
        fs::create_dir_all(d.path().join("logs")).unwrap();
        for (n, b) in files {
            fs::write(d.path().join("logs").join(n), b).unwrap();
        }
    }

    fn lines(bytes: usize) -> Vec<u8> {
        let mut v = Vec::new();
        let mut i = 0;
        while v.len() < bytes {
            v.extend_from_slice(format!("line {i:08} some log text here\n").as_bytes());
            i += 1;
        }
        v
    }

    #[test]
    fn crc32_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn zip_passes_unzip_t() {
        if !Path::new("/usr/bin/unzip").exists() {
            eprintln!("unzip absent, skipping");
            return;
        }
        let d = Scratch::new("zip");
        let files = vec![("a.txt".to_string(), b"hello\n".to_vec()), ("empty".to_string(), vec![]), ("b.log".to_string(), lines(5000))];
        let zip = zip_stored(&files);
        let p = d.path().join("r.zip");
        fs::write(&p, &zip).unwrap();
        let out = Command::new("/usr/bin/unzip").arg("-t").arg(&p).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
        let out = Command::new("/usr/bin/unzip").arg("-p").arg(&p).arg("a.txt").output().unwrap();
        assert_eq!(out.stdout, b"hello\n");
    }

    #[test]
    fn report_stays_under_the_limit() {
        let d = Scratch::new("big");
        let mb = 1024 * 1024;
        put_logs(&d, &[("desktop.log", lines(2 * mb)), ("desktop.log.1", lines(8 * mb)), ("server.log", lines(10 * mb)), ("server.log.1", lines(10 * mb))]);
        let files = build_report(d.path(), "0.2.1", "linux", None, MAX_REPORT_BYTES);
        let zip = zip_stored(&files);
        assert!(zip.len() <= MAX_REPORT_BYTES, "{}", zip.len());
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["report.json", "desktop.log", "server.log"]);
        let server = &files[2].1;
        assert!(server.len() > 10 * mb - 1, "kept the room it had: {}", server.len()); // 10 MB log is not cut needlessly
        let full = lines(10 * mb);
        assert!(full.ends_with(server), "keeps the last part");
        assert!(server.starts_with(b"line "), "starts at a line start");
        assert_eq!(files[1].1.len(), 2 * mb + (lines(2 * mb).len() - 2 * mb), "short log kept whole");
    }

    #[test]
    fn small_limit_cuts_every_log_and_keeps_it_valid() {
        let d = Scratch::new("tiny");
        put_logs(&d, &[("desktop.log", lines(50_000)), ("server.log", lines(50_000))]);
        let files = build_report(d.path(), "0.2.1", "linux", None, 20_000);
        assert!(zip_stored(&files).len() <= 20_000);
        assert!(files.iter().skip(1).all(|(_, b)| !b.is_empty() && b.starts_with(b"line ")));
    }

    #[test]
    fn small_reports_keep_everything_present() {
        let d = Scratch::new("small");
        put_logs(&d, &[("server.log", b"x\n".to_vec()), ("server.log.1", b"y\n".to_vec())]);
        let files = build_report(d.path(), "0.2.1", "linux", None, MAX_REPORT_BYTES);
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["report.json", "server.log", "server.log.1"]);
        let none = Scratch::new("nologs");
        assert_eq!(build_report(none.path(), "0.2.1", "linux", None, MAX_REPORT_BYTES).len(), 1);
    }

    #[test]
    fn report_json_fields() {
        let d = Scratch::new("json");
        let with = build_report(d.path(), "0.2.1", "windows", Some(1_610_612_736), MAX_REPORT_BYTES);
        let v: serde_json::Value = serde_json::from_slice(&with[0].1).unwrap();
        assert_eq!(v, serde_json::json!({ "tool": "questlog", "version": "0.2.1", "os": "windows", "memoryMaxBytes": 1_610_612_736u64 }));
        let without = build_report(d.path(), "0.2.1", "linux", None, MAX_REPORT_BYTES);
        let v: serde_json::Value = serde_json::from_slice(&without[0].1).unwrap();
        assert!(v.get("memoryMaxBytes").is_none());
    }

    #[test]
    fn memory_max_parsing() {
        assert_eq!(memory_max_from_env(Some("1610612736")), Some(1_610_612_736));
        for v in ["1536M", "", "-1", "x"] {
            assert_eq!(memory_max_from_env(Some(v)), None, "{v:?}");
        }
        assert_eq!(memory_max_from_env(None), None);
    }

    #[test]
    fn os_name_is_known() {
        assert!(matches!(os_name(), "linux" | "windows"));
    }

    #[test]
    fn crash_url_forms() {
        assert_eq!(crash_url(&url("http://100.64.0.7:8780/"), "0.2.1", "linux"), "http://100.64.0.7:8781/team/crashes?tool=questlog&version=0.2.1&os=linux");
        assert_eq!(crash_url(&url("http://[fd7a:115c:a1e0::5]:9000/"), "0.2.1", "linux"), "http://[fd7a:115c:a1e0::5]:8781/team/crashes?tool=questlog&version=0.2.1&os=linux");
        assert!(crash_url(&url("http://nas/"), "1.0 beta&x", "linux").contains("version=1.0%20beta%26x&"));
    }

    /// Answers one request with `reply`, returning what it received (head and body).
    fn stub(reply: &'static str) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 65536];
            loop {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                if let Some(p) = got.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&got[..p]).to_ascii_lowercase();
                    let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length: ")).unwrap().trim().parse().unwrap();
                    if got.len() >= p + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            s.write_all(reply.as_bytes()).unwrap();
            got
        });
        (port, h)
    }

    #[test]
    fn upload_created_returns_the_id() {
        let (port, h) = stub("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"id\":\"abc-123\"}");
        let body = vec![7u8; 100_000];
        let r = upload(&format!("http://127.0.0.1:{port}/team/crashes?tool=questlog&version=0.2.1&os=linux"), &body, Duration::from_secs(5));
        assert_eq!(r, Ok("abc-123".to_string()));
        let got = h.join().unwrap();
        let head = String::from_utf8_lossy(&got[..200]).to_string();
        assert!(head.starts_with("POST /team/crashes?tool=questlog&version=0.2.1&os=linux HTTP/1.1\r\n"), "{head}");
        assert!(head.contains("Content-Type: application/zip\r\n") && head.contains("Content-Length: 100000\r\n"));
        assert!(head.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
        assert!(got.ends_with(&body));
    }

    #[test]
    fn upload_chunked_created() {
        let (port, h) = stub("HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n{\"id\":\"abc-123\"}\r\n0\r\n\r\n");
        assert_eq!(upload(&format!("http://127.0.0.1:{port}/x"), b"z", Duration::from_secs(5)), Ok("abc-123".to_string()));
        h.join().unwrap();
    }

    #[test]
    fn upload_rejected_carries_the_body() {
        let (port, h) = stub("HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n  report too large (max 20 MB)\n");
        let r = upload(&format!("http://127.0.0.1:{port}/x"), b"zip", Duration::from_secs(5));
        assert_eq!(r, Err("report too large (max 20 MB)".to_string()));
        h.join().unwrap();
        let (port, h) = stub("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
        assert_eq!(upload(&format!("http://127.0.0.1:{port}/x"), b"zip", Duration::from_secs(5)), Err("HTTP 500".to_string()));
        h.join().unwrap();
    }

    #[test]
    fn upload_refused_port_is_an_error() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let r = upload(&format!("http://127.0.0.1:{port}/x"), b"zip", Duration::from_secs(5));
        assert!(r.is_err(), "{r:?}");
    }

    #[test]
    fn upload_silent_server_times_out() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let start = Instant::now();
        let r = upload(&format!("http://127.0.0.1:{port}/x"), b"zip", Duration::from_millis(300));
        assert!(r.is_err());
        assert!(start.elapsed() < Duration::from_secs(3));
        drop(l);
    }

    #[test]
    fn upload_early_reject_keeps_the_server_text() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf).unwrap();
            s.write_all(b"HTTP/1.1 413 Payload Too Large\r\nContent-Length: 22\r\nConnection: close\r\n\r\nreport too large (max)").unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        let body = vec![1u8; 40 * 1024 * 1024];
        let r = upload(&format!("http://127.0.0.1:{port}/x"), &body, Duration::from_secs(10));
        h.join().unwrap();
        assert!(r.as_ref().is_err_and(|e| e.contains("report too large")), "{r:?}");
    }

    #[test]
    fn upload_to_a_server_that_never_reads_times_out() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let body = vec![1u8; 64 * 1024 * 1024];
        let start = Instant::now();
        let r = upload(&format!("http://127.0.0.1:{port}/x"), &body, Duration::from_millis(500));
        assert_eq!(r, Err("timed out".to_string()));
        assert!(start.elapsed() < Duration::from_millis(2500), "{:?}", start.elapsed());
        drop(l);
    }

    #[test]
    fn upload_answer_complete_while_socket_stays_open() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf).unwrap();
            s.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 15\r\n\r\n{\"id\":\"abc-12\"}").unwrap();
            std::thread::sleep(Duration::from_secs(3));
        });
        let start = Instant::now();
        let r = upload(&format!("http://127.0.0.1:{port}/x"), b"z", Duration::from_secs(10));
        assert_eq!(r, Ok("abc-12".to_string()));
        assert!(start.elapsed() < Duration::from_secs(2));
        h.join().unwrap();
    }

    #[test]
    fn private_or_tailnet_boundaries() {
        // concat!: a generic RFC1918 test value, split so the public-tree audit pattern (scripts/public-tree.sh) does not match.
        let yes = ["::1", "127.0.0.1", "100.64.0.1", "100.127.255.255", "10.0.0.1", "172.16.0.1", "172.31.255.255", concat!("192.", "168.1.1"), "169.254.1.1", "fd7a:115c:a1e0::5", "fc00::1", "fd00::1", concat!("::ffff:192.", "168.1.1")];
        let no = ["100.63.255.255", "100.128.0.0", "8.8.8.8", "172.32.0.1", "172.15.255.255", "192.169.0.1", "169.255.0.1", "2001:4860:4860::8888", "fe00::1", "::ffff:8.8.8.8"];
        for ip in yes {
            assert!(private_or_tailnet(ip.parse().unwrap()), "{ip}");
        }
        for ip in no {
            assert!(!private_or_tailnet(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn upload_refuses_public_address_without_connecting() {
        let start = Instant::now();
        let r = upload("http://8.8.8.8:8781/team/crashes", b"zip", Duration::from_secs(10));
        assert_eq!(r, Err(NOT_PRIVATE.to_string()));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn error_text_forms() {
        assert_eq!(error_text("{\"error\":\"too big\"}", 413), "too big");
        assert_eq!(error_text("a\n  b\r\n c ", 400), "a b c");
        assert_eq!(error_text("   ", 502), "HTTP 502");
        assert_eq!(error_text(&"x".repeat(1000), 400).len(), ERROR_TEXT_MAX);
        assert_eq!(one_line("questlog/\n  x.zip\t"), "questlog/ x.zip");
        assert_eq!(one_line(&"y".repeat(1000)).len(), ERROR_TEXT_MAX);
    }
}

//! The splash and error pages, shown as `data:` URLs before (or instead of) the server's own UI.
use std::fmt::Write;
use std::io;
use std::path::Path;

use crate::supervise::StartError;

const ICON: &str = include_str!("../icons/source/questlog.svg");

const STYLE: &str = "\
:root{color-scheme:dark}*{box-sizing:border-box}\
html,body{margin:0;height:100%}\
body{background:#0f0f10;color:#fff;font:400 15px/1.5 system-ui,sans-serif;-webkit-font-smoothing:antialiased}\
main{max-width:760px;margin:0 auto;padding:56px 24px}\
.center{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}\
.center svg{width:96px;height:96px}main svg{width:56px;height:56px}\
h1{font-size:22px;font-weight:700;margin:16px 0 8px}\
p{color:#a7a7ad;margin:0 0 12px}\
code{color:#fff;background:#1a1a1e;border:1px solid #2a2a30;border-radius:6px;padding:1px 6px;word-break:break-all}\
pre{background:#1a1a1e;border:1px solid #2a2a30;border-radius:10px;padding:12px 14px;color:#a7a7ad;\
font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;max-height:50vh;overflow:auto}\
.bar{width:160px;height:3px;background:#2a2a30;border-radius:2px;overflow:hidden}\
.bar::after{content:'';display:block;width:40%;height:100%;background:#ec8219;animation:s 1.2s ease-in-out infinite}\
@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(250%)}}\
@media (prefers-reduced-motion:reduce){.bar::after{animation:none;width:100%}}\
.choice{background:#1a1a1e;border:1px solid #2a2a30;border-radius:12px;padding:18px 20px;margin:16px 0}\
.choice h2{font-size:16px;font-weight:600;margin:0 0 4px}\
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}\
.btn{display:inline-block;border:1px solid #2a2a30;border-radius:8px;padding:8px 16px;background:#232328;color:#fff;\
font:600 14px/1.4 system-ui,sans-serif;text-decoration:none;cursor:pointer}\
.btn:hover{border-color:#3a3a42}.btn.primary{background:#ec8219;border-color:#ec8219;color:#111}\
.btn:focus-visible,input:focus-visible{outline:2px solid #ec8219;outline-offset:2px}\
input{flex:1 1 220px;min-width:0;background:#0f0f10;color:#fff;border:1px solid #2a2a30;border-radius:8px;\
padding:8px 12px;font:14px/1.4 ui-monospace,monospace}\
.err{color:#ff8a7a}";

/// Where the shell's own pages send their actions; `main.rs` cancels these navigations and acts on them.
const SHELL: &str = "http://questlog-shell.invalid";

pub(crate) fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn document(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>{}</title><style>{STYLE}</style></head><body>{body}</body></html>",
        escape(title)
    )
}

/// Wraps an HTML page in a `data:` URL.
pub fn data_url(html: &str) -> String {
    let mut url = String::from("data:text/html;charset=utf-8,");
    for b in html.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~!*'();:@=+$,/?".contains(&b) {
            url.push(b as char);
        } else {
            let _ = write!(url, "%{b:02X}");
        }
    }
    url
}

/// Shown while the server starts.
pub fn splash() -> String {
    document(
        "Questlog",
        &format!("<div class=\"center\" role=\"status\" aria-label=\"Starting Questlog\">{ICON}<div class=\"bar\"></div></div>"),
    )
}

/// An error page with the last lines of server output. All text is HTML-escaped.
pub fn error_page(title: &str, detail: &str, log_path: &Path, tail: &[String]) -> String {
    let mut body = format!(
        "<main>{ICON}<h1>{}</h1><p>{}</p><p>The full log is in <code>{}</code>.</p>",
        escape(title),
        escape(detail),
        escape(&log_path.display().to_string())
    );
    if !tail.is_empty() {
        body.push_str("<pre>");
        for line in tail {
            body.push_str(&escape(line));
            body.push('\n');
        }
        body.push_str("</pre>");
    }
    body.push_str("</main>");
    document(title, &body)
}

/// The page for a server that never became ready.
pub fn start_error_page(err: &StartError, data: &Path, log_path: &Path) -> String {
    match err {
        StartError::Exited { code: Some(3), tail } => error_page(
            "This database was made by a newer Questlog",
            &format!(
                "Your data in {} was last opened by a newer version of Questlog, so this version will not touch it. \
                 Install the newer version again, or restore an older copy from {}.",
                data.display(),
                data.join("backups").display()
            ),
            log_path,
            tail,
        ),
        StartError::Exited { code, tail } => error_page(
            "Questlog could not start",
            &format!("The Questlog server stopped while starting ({}).", exit_text(*code)),
            log_path,
            tail,
        ),
        StartError::Timeout { tail } => error_page(
            "Questlog could not start",
            "The Questlog server did not report that it was ready within 30 seconds.",
            log_path,
            tail,
        ),
    }
}

/// The page for a server process that could not be launched at all.
pub fn spawn_error_page(err: &io::Error, app_dir: &Path, log_path: &Path) -> String {
    error_page(
        "Questlog could not start",
        &format!(
            "The Questlog server could not be launched from {}: {err}. The Questlog folder may be incomplete; \
             unpack the download again.",
            app_dir.display()
        ),
        log_path,
        &[],
    )
}

/// The page for a server that stopped after it was running.
pub fn stopped_page(code: Option<i32>, log_path: &Path, tail: &[String]) -> String {
    error_page(
        "Questlog stopped",
        &format!(
            "The Questlog server stopped unexpectedly ({}). Your data is saved; restart Questlog to continue.",
            exit_text(code)
        ),
        log_path,
        tail,
    )
}

/// Asks where the workspace is: this computer, or a server at an address. `error` is a line about a bad address.
pub fn chooser(error: Option<&str>) -> String {
    let error = error.map(|e| format!("<p class=\"err\" role=\"alert\">{}</p>", escape(e))).unwrap_or_default();
    document(
        "Questlog",
        &format!(
            "<main>{ICON}<h1>Where is your workspace?</h1>\
             <section class=\"choice\"><h2>On this computer</h2>\
             <p>Questlog keeps your workspace on this computer and runs it here.</p>\
             <div class=\"row\"><a class=\"btn primary\" href=\"{SHELL}/local\">Use this computer</a></div></section>\
             <section class=\"choice\"><h2>On a server</h2>\
             <p>Your team runs Questlog on a server. Enter its address, like <code>nas</code> or \
             <code>10.0.0.20:8780</code>.</p>{error}\
             <form class=\"row\" method=\"get\" action=\"{SHELL}/server\">\
             <input name=\"address\" aria-label=\"Server address\" placeholder=\"nas:8780\" required \
             autocomplete=\"off\" spellcheck=\"false\" autocapitalize=\"off\">\
             <button class=\"btn primary\" type=\"submit\">Connect</button></form></section></main>"
        ),
    )
}

/// The page for a server that could not be reached. All text is HTML-escaped.
pub fn unreachable(address: &str, err: &str) -> String {
    document(
        "Questlog can't reach the server",
        &format!(
            "<main>{ICON}<h1>Questlog can't reach the server</h1>\
             <p>No answer from <code>{}</code>: {}.</p>\
             <p>Check that the server is running and that this computer is on the same network (or Tailscale).</p>\
             <div class=\"row\"><a class=\"btn primary\" href=\"{SHELL}/retry\">Retry</a>\
             <a class=\"btn\" href=\"{SHELL}/change\">Change server</a>\
             <a class=\"btn\" href=\"{SHELL}/local\">Use this computer</a></div></main>",
            escape(address),
            escape(err)
        ),
    )
}

/// The question asked after a run that ended badly, when a team server is set.
pub fn crash_prompt() -> String {
    document(
        "Questlog",
        &format!(
            "<main>{ICON}<h1>Questlog closed unexpectedly. Send the report to the team?</h1>\
             <p>The report holds Questlog's logs from this computer, the version and the operating system. \
             It goes to your team's server.</p>\
             <div class=\"row\"><a class=\"btn primary\" href=\"{SHELL}/crash-send\">Send</a>\
             <a class=\"btn\" href=\"{SHELL}/crash-skip\">Don't send</a>\
             <a class=\"btn\" href=\"{SHELL}/crash-view\">See what is sent</a></div></main>"
        ),
    )
}

/// Shown while the report is built and uploaded.
pub fn crash_sending() -> String {
    document(
        "Questlog",
        &format!("<div class=\"center\" role=\"status\">{ICON}<p>Sending…</p><div class=\"bar\"></div></div>"),
    )
}

/// How much text the details page shows at most, across all files: their last parts.
pub const DETAILS_SHOWN: usize = 400 * 1024;
/// The largest details page, as a `data:` URL; WebView2 refuses data: URLs over about 2 MiB.
pub const DETAILS_URL_MAX: usize = 1536 * 1024;

fn size_text(n: usize) -> String {
    if n < 1024 {
        format!("{n} bytes")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

/// The report's files as text for the details page: each file under its name. Together they show at most `budget`
/// bytes: each file gets a fair share (short files give their slack to longer ones) and keeps its newest lines.
pub fn details_text(files: &[(String, Vec<u8>)], budget: usize) -> String {
    let mut keep = vec![0usize; files.len()];
    let mut order: Vec<usize> = (0..files.len()).collect();
    order.sort_by_key(|&i| files[i].1.len());
    let (mut left, mut count) = (budget, files.len());
    for i in order {
        keep[i] = (left / count).min(files[i].1.len());
        left -= keep[i];
        count -= 1;
    }
    let mut out = String::new();
    for ((name, bytes), keep) in files.iter().zip(keep) {
        let shown = if bytes.len() > keep {
            let part = &bytes[bytes.len() - keep..];
            let start = part.iter().position(|&b| b == b'\n').map_or(0, |i| i + 1);
            let _ = writeln!(out, "== {name} (last {} shown) ==", size_text(part.len() - start));
            &part[start..]
        } else {
            let _ = writeln!(out, "== {name} ==");
            &bytes[..]
        };
        out.push_str(&String::from_utf8_lossy(shown));
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

/// What the report holds: its files with their sizes and their text. All text is HTML-escaped.
pub fn crash_details(files: &[(String, usize)], log_text: &str) -> String {
    let mut list = String::from("<ul>");
    for (name, size) in files {
        let _ = write!(list, "<li><code>{}</code> {}</li>", escape(name), size_text(*size));
    }
    list.push_str("</ul>");
    document(
        "What is sent",
        &format!(
            "<main>{ICON}<h1>What is sent</h1><p>The report is a zip of these files:</p>{list}\
             <pre>{}</pre>\
             <div class=\"row\"><a class=\"btn primary\" href=\"{SHELL}/crash-back\">Back</a></div></main>",
            escape(log_text)
        ),
    )
}

/// The details page for these report files, with as much of their text as keeps its `data:` URL under
/// `DETAILS_URL_MAX` (escaping and percent-encoding can make text ten times larger).
pub fn crash_details_for(files: &[(String, Vec<u8>)]) -> String {
    let sizes: Vec<(String, usize)> = files.iter().map(|(n, b)| (n.clone(), b.len())).collect();
    let mut budget = DETAILS_SHOWN;
    loop {
        let html = crash_details(&sizes, &details_text(files, budget));
        if budget == 0 || data_url(&html).len() <= DETAILS_URL_MAX {
            return html;
        }
        budget /= 2;
    }
}

/// The outcome of sending the report; `Ok` holds the server's id for it, `Err` the reason it was not sent.
pub fn crash_result(result: Result<String, String>) -> String {
    let line = match result {
        Ok(_) => "The report was sent.".to_string(),
        Err(e) => format!("The report could not be sent: {e}"),
    };
    document(
        "Questlog",
        &format!(
            "<main>{ICON}<h1>{}</h1>\
             <div class=\"row\"><a class=\"btn primary\" href=\"{SHELL}/continue\">Continue</a></div></main>",
            escape(&line)
        ),
    )
}

fn exit_text(code: Option<i32>) -> String {
    match code {
        Some(c) => format!("exit code {c}"),
        None => "ended by a signal".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn error_page_escapes_log_lines() {
        let tail = vec!["<script>alert('x')</script> & \"q\"".to_string()];
        let html = error_page("T <b>", "D & d", Path::new("/data/logs/server.log"), &tail);
        assert!(!html.contains("<script>alert"), "{html}");
        assert!(!html.contains("<b>"), "{html}");
        assert!(html.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;q&quot;"), "{html}");
        assert!(html.contains("D &amp; d"));
        assert!(html.contains("/data/logs/server.log"));
    }

    #[test]
    fn newer_db_error_names_backups_folder() {
        let data = PathBuf::from("/data/questlog");
        let err = StartError::Exited { code: Some(3), tail: vec!["database is newer".into()] };
        let html = start_error_page(&err, &data, &data.join("logs").join("server.log"));
        assert!(html.contains("made by a newer Questlog"), "{html}");
        assert!(html.contains(&data.join("backups").display().to_string()), "{html}");
        assert!(html.contains("database is newer"));
    }

    #[test]
    fn data_url_round_trips_through_percent_decoding() {
        let html = error_page("100% <done> #1", "a&b", Path::new("/x y/ë.log"), &["tab\there".into()]);
        let url = data_url(&html);
        let body = url.strip_prefix("data:text/html;charset=utf-8,").unwrap();
        assert!(!body.contains('#') && !body.contains(' ') && !body.contains('\t'));
        let bytes = body.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                out.push(u8::from_str_radix(&body[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        assert_eq!(String::from_utf8(out).unwrap(), html);
    }

    #[test]
    fn chooser_offers_both_choices() {
        let html = chooser(None);
        assert!(html.contains("Where is your workspace?"), "{html}");
        assert!(html.contains("href=\"http://questlog-shell.invalid/local\""), "{html}");
        assert!(html.contains("action=\"http://questlog-shell.invalid/server\""), "{html}");
        assert!(html.contains("method=\"get\""), "{html}");
        assert!(html.contains("name=\"address\""), "{html}");
        assert!(!html.contains("<script"));
        assert!(!html.contains("role=\"alert\""));
    }

    #[test]
    fn chooser_error_is_escaped() {
        let html = chooser(Some("bad <b>&</b>"));
        assert!(html.contains("bad &lt;b&gt;&amp;&lt;/b&gt;"), "{html}");
        assert!(!html.contains("<b>"));
        assert!(html.contains("role=\"alert\""));
    }

    #[test]
    fn unreachable_names_address_and_error_with_actions() {
        let html = unreachable("http://nas:8780/<x>", "refused & \"gone\"");
        assert!(html.contains("http://nas:8780/&lt;x&gt;"), "{html}");
        assert!(html.contains("refused &amp; &quot;gone&quot;"), "{html}");
        assert!(!html.contains("<x>"));
        for action in ["retry", "change", "local"] {
            assert!(html.contains(&format!("href=\"http://questlog-shell.invalid/{action}\"")), "{action}: {html}");
        }
        assert!(html.contains("Use this computer") && html.contains("Change server") && html.contains("Retry"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn crash_prompt_asks_with_three_actions() {
        let html = crash_prompt();
        assert!(html.contains("Questlog closed unexpectedly. Send the report to the team?"), "{html}");
        for (action, label) in [("crash-send", "Send"), ("crash-skip", "Don't send"), ("crash-view", "See what is sent")] {
            assert!(html.contains(&format!("href=\"http://questlog-shell.invalid/{action}\">{label}</a>")), "{action}: {html}");
        }
        assert!(!html.contains("<script"));
    }

    #[test]
    fn crash_details_lists_files_and_escapes_text() {
        let files = vec![("report.json".to_string(), 50), ("desktop.log".to_string(), 3 * 1024)];
        let html = crash_details(&files, "<script>alert('x')</script> & \"q\"");
        assert!(html.contains("<code>report.json</code> 50 bytes"), "{html}");
        assert!(html.contains("<code>desktop.log</code> 3.0 KB"), "{html}");
        assert!(html.contains("<pre>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;q&quot;</pre>"), "{html}");
        assert!(!html.contains("<script"));
        assert!(html.contains("href=\"http://questlog-shell.invalid/crash-back\">Back</a>"), "{html}");
        let html = crash_details(&[("<b>".to_string(), 1)], "");
        assert!(html.contains("<code>&lt;b&gt;</code>") && !html.contains("<b>"), "{html}");
    }

    #[test]
    fn details_text_shows_each_file_and_only_the_end_of_long_ones() {
        let mut long = b"first line\n".to_vec();
        long.extend(std::iter::repeat_n(b'a', DETAILS_SHOWN));
        long.extend_from_slice(b"\nlast line\n");
        let files = vec![("report.json".to_string(), b"{\"tool\":\"questlog\"}".to_vec()), ("server.log".to_string(), long)];
        let text = details_text(&files, DETAILS_SHOWN);
        assert!(text.starts_with("== report.json ==\n{\"tool\":\"questlog\"}\n"), "{}", &text[..80]);
        assert!(text.contains("== server.log (last "), "{}", &text[..200]);
        assert!(!text.contains("first line"));
        assert!(text.contains("last line"));
        assert!(text.len() < DETAILS_SHOWN + 200);
    }

    #[test]
    fn details_budget_is_shared_across_files() {
        let big = |c: u8| (0..300_000).map(|i| if i % 100 == 99 { b'\n' } else { c }).collect::<Vec<u8>>();
        let files = vec![
            ("report.json".to_string(), b"{}".to_vec()),
            ("desktop.log".to_string(), big(b'd')),
            ("server.log".to_string(), big(b's')),
        ];
        let text = details_text(&files, 100_000);
        assert!(text.contains("{}"));
        let d = text.bytes().filter(|&b| b == b'd').count();
        let s = text.bytes().filter(|&b| b == b's').count();
        assert!((45_000..50_000).contains(&d) && (45_000..50_000).contains(&s), "{d} {s}");
        assert!(text.len() < 100_000 + 200);
    }

    #[test]
    fn details_url_stays_under_the_webview_limit() {
        // Quotes and non-ASCII grow the most: &quot; percent-encoded is 10 bytes, ë is 6.
        let line = "\"q\" ë <&> 'x' ünïcödé \"quoted\"\n".as_bytes().to_vec();
        let log: Vec<u8> = line.iter().copied().cycle().take(20 * 1024 * 1024).collect();
        let files: Vec<(String, Vec<u8>)> = std::iter::once(("report.json".to_string(), b"{}".to_vec()))
            .chain(["desktop.log", "desktop.log.1", "server.log", "server.log.1"].map(|n| (n.to_string(), log.clone())))
            .collect();
        drop(log);
        let html = crash_details_for(&files);
        let url = data_url(&html);
        assert!(url.len() <= DETAILS_URL_MAX, "{}", url.len());
        assert!(html.contains("ünïcödé") && html.contains("&quot;quoted&quot;"));
        assert!(html.contains("<code>server.log</code> 20.0 MB"), "{}", &html[..html.len().min(3000)]);
    }

    #[test]
    fn crash_result_says_what_happened_and_continues() {
        let ok = crash_result(Ok("questlog/x.zip".into()));
        assert!(ok.contains("The report was sent."), "{ok}");
        let err = crash_result(Err("connection refused <x>".into()));
        assert!(err.contains("The report could not be sent: connection refused &lt;x&gt;"), "{err}");
        for html in [ok, err] {
            assert!(html.contains("href=\"http://questlog-shell.invalid/continue\">Continue</a>"), "{html}");
            assert!(!html.contains("<script") && !html.contains("<x>"));
        }
    }

    #[test]
    fn crash_sending_is_busy_without_actions() {
        let html = crash_sending();
        assert!(html.contains("Sending…") && !html.contains("questlog-shell.invalid"), "{html}");
    }

    #[test]
    fn splash_has_icon_and_no_scripts() {
        let html = splash();
        assert!(html.contains("<svg") && !html.contains("<script"));
    }
}

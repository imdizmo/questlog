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

fn escape(s: &str) -> String {
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
    fn splash_has_icon_and_no_scripts() {
        let html = splash();
        assert!(html.contains("<svg") && !html.contains("<script"));
    }
}

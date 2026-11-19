//! The workspace strip: a narrow column at the window's left with one button per workspace (this computer, each
//! known team server) and "+" for the chooser. It is the shell's own webview, next to the one that shows the server's
//! UI, and only ever shows the page built here. Like the shell's other pages it has no Tauri permissions: a click is a
//! navigation to `http://questlog-strip.invalid/<action>`, which the strip's own navigation handler cancels and acts
//! on. The server's webview never sees those (its handler blocks the host), so a server's page cannot switch.
use std::net::IpAddr;

use tauri::Url;

use crate::pages::escape;
use crate::shell;

/// The strip's width, in logical pixels.
pub const STRIP_WIDTH: f64 = 56.0;
pub const STRIP_HOST: &str = "questlog-strip.invalid";
const STRIP: &str = "http://questlog-strip.invalid";

/// What a click in the strip asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum StripAction {
    /// This computer.
    Local,
    /// A team server, by its address as the page has it (checked against the known servers before use).
    Server(String),
    /// "+": the chooser.
    Choose,
    /// Esc in the strip: back to the page.
    App,
}

/// The strip's actions. Anything else at the strip's host (another path, scheme, port, credentials) is none.
pub fn strip_action(url: &Url) -> Option<StripAction> {
    if url.scheme() != "http"
        || url.host_str() != Some(STRIP_HOST)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    match url.path() {
        "/local" => Some(StripAction::Local),
        "/choose" => Some(StripAction::Choose),
        "/app" => Some(StripAction::App),
        "/server" => {
            let (_, address) = url.query_pairs().find(|(k, _)| k == "url")?;
            Some(StripAction::Server(address.into_owned()))
        }
        _ => None,
    }
}

/// Whether `url` is addressed to the strip (any scheme or path): the server's webview must never load or open it.
pub fn is_strip_host(url: &Url) -> bool {
    url.host_str().is_some_and(|h| h.eq_ignore_ascii_case(STRIP_HOST))
}

/// What the strip's webview does with a navigation.
#[derive(Debug, PartialEq)]
pub enum StripNav {
    /// The page the shell itself navigated it to.
    Allow,
    /// Cancel it and act on it.
    Act(StripAction),
    /// Cancel it: any other page, link or address.
    Block,
}

/// The strip webview's navigation handler's view: the one page it may show.
#[derive(Default)]
pub struct StripGate {
    /// The strip page the shell last navigated to (a one-time data: URL).
    pub expected: Option<Url>,
    /// That page's HTML without its nonce, so an unchanged strip is not reloaded.
    pub html: String,
}

impl StripGate {
    pub fn decide(&self, url: &Url) -> StripNav {
        if self.expected.as_ref() == Some(url) {
            return StripNav::Allow;
        }
        match strip_action(url) {
            Some(action) => StripNav::Act(action),
            None => StripNav::Block,
        }
    }
}

/// Which button the strip highlights.
#[derive(Debug, Clone, PartialEq)]
pub enum Current {
    /// Starting, restarting, or not the instance that holds the data folder.
    Nothing,
    /// The chooser shows ("+").
    Choosing,
    Local,
    Team(Url),
}

/// One or two characters for a team server's button: an IP address's last part, else the host's first two letters.
pub fn initials(url: &Url) -> String {
    let host = url.host_str().unwrap_or("?").trim_start_matches('[').trim_end_matches(']');
    if host.parse::<IpAddr>().is_ok() {
        let last = host.rsplit(['.', ':']).find(|p| !p.is_empty()).unwrap_or("?");
        return last.chars().take(3).collect::<String>().to_uppercase();
    }
    let s: String = host.chars().filter(|c| c.is_alphanumeric()).take(2).collect();
    if s.is_empty() {
        "?".into()
    } else {
        s.to_uppercase()
    }
}

/// The server action's link for `server`.
fn server_href(server: &Url) -> String {
    let mut u = Url::parse(&format!("{STRIP}/server")).expect("strip url");
    u.query_pairs_mut().append_pair("url", server.as_str());
    u.to_string()
}

/// What the strip page may load: its own inline style and script, nothing else (no requests, frames, images).
const CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; \
form-action 'none'";

const STYLE: &str = "\
:root{color-scheme:dark}*{box-sizing:border-box}\
html,body{margin:0;height:100%;overflow:hidden}\
body{background:#0b0b0c;border-right:1px solid #232328;color:#d7d7dc;font:700 13px/1 system-ui,sans-serif;\
-webkit-font-smoothing:antialiased;user-select:none}\
nav{height:100%;overflow-y:auto;overflow-x:hidden;padding:10px 0}\
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;align-items:center;gap:8px}\
li{position:relative;display:flex;justify-content:center;width:100%}\
li.cur::before{content:'';position:absolute;left:0;top:8px;width:4px;height:24px;border-radius:0 3px 3px 0;\
background:#ec8219}\
.ws{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:#1a1a1e;\
border:1px solid #2a2a30;color:#d7d7dc;text-decoration:none;transition:border-radius .15s,border-color .15s}\
.ws:hover{border-color:#4a4a52;border-radius:10px}\
.ws[aria-current]{background:#ec8219;border-color:#ec8219;color:#111}\
.ws:focus-visible{outline:2px solid #ec8219;outline-offset:2px}\
.add{background:transparent;border-style:dashed;color:#a7a7ad}\
.sep{width:28px;height:1px;background:#2a2a30;margin:2px 0}\
.busy .ws{opacity:.45;pointer-events:none}\
svg{width:20px;height:20px;display:block}\
@media (prefers-reduced-motion:reduce){.ws{transition:none}}";

/// Arrow keys, Home and End move between the buttons; Esc goes back to the page. A strip that gets the focus puts
/// it on the highlighted button. Nothing dropped on the strip is taken (on Linux it is no drop target at all).
const SCRIPT: &str = "(()=>{const a=[...document.querySelectorAll('a.ws')];\
const cur=()=>document.querySelector('a.ws[aria-current]')||a[0];\
addEventListener('focus',()=>{if(document.activeElement===document.body&&a.length)cur().focus()});\
document.addEventListener('keydown',e=>{const i=a.indexOf(document.activeElement);let n=-1;\
if(e.key==='ArrowDown')n=i<0?0:(i+1)%a.length;else if(e.key==='ArrowUp')n=i<0?a.length-1:(i+a.length-1)%a.length;\
else if(e.key==='Home')n=0;else if(e.key==='End')n=a.length-1;\
else if(e.key==='Escape'){e.preventDefault();location.href='http://questlog-strip.invalid/app';return}\
if(n>=0&&a[n]){e.preventDefault();a[n].focus()}});for(const t of['dragenter','dragover','drop'])addEventListener(t,e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='none'},true)})()";

/// A screen (this computer), drawn here.
const COMPUTER: &str = "<svg viewBox=\"0 0 20 20\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" \
stroke-width=\"1.6\" stroke-linejoin=\"round\"><rect x=\"2.5\" y=\"3.5\" width=\"15\" height=\"10\" rx=\"1.5\"/>\
<path d=\"M7 17h6M10 13.5V17\" stroke-linecap=\"round\"/></svg>";
const PLUS: &str = "<svg viewBox=\"0 0 20 20\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" \
stroke-width=\"1.8\" stroke-linecap=\"round\"><path d=\"M10 4v12M4 10h12\"/></svg>";

fn item(href: &str, label: &str, tip: &str, class: &str, current: bool, inner: &str) -> String {
    let (li, cur, said) = if current { (" class=\"cur\"", " aria-current=\"true\"", " (current)") } else { ("", "", "") };
    format!(
        "<li{li}><a class=\"ws {class}\" href=\"{}\" aria-label=\"{}{said}\" title=\"{}\"{cur}>{inner}</a></li>",
        escape(href),
        escape(label),
        escape(tip)
    )
}

/// The strip's page: this computer, a separator, each known team server, "+". `busy` (starting or restarting)
/// greys the buttons out; the shell ignores clicks then anyway.
pub fn page(known: &[Url], current: &Current, busy: bool) -> String {
    let mut items = item(
        &format!("{STRIP}/local"),
        "This computer",
        "This computer: the workspace kept on this computer",
        "local",
        *current == Current::Local,
        COMPUTER,
    );
    items.push_str("<li aria-hidden=\"true\"><div class=\"sep\"></div></li>");
    for url in known {
        let host = shell::host_label(url);
        items.push_str(&item(
            &server_href(url),
            &format!("Team server {host}"),
            &format!("Team server: {host}"),
            "team",
            *current == Current::Team(url.clone()),
            &escape(&initials(url)),
        ));
    }
    items.push_str(&item(
        &format!("{STRIP}/choose"),
        "Add or change a server",
        "Add or change a server…",
        "add",
        *current == Current::Choosing,
        PLUS,
    ));
    let busy = if busy { " class=\"busy\" aria-busy=\"true\"" } else { "" };
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\"><title>Workspaces</title>\
         <style>{STYLE}</style></head><body><nav aria-label=\"Workspaces\"{busy}><ul>{items}</ul></nav>\
         <script>{SCRIPT}</script></body></html>"
    )
}

/// The data: URL of a page, for tests (the shell adds a nonce).
#[cfg(test)]
fn url_of(html: &str) -> Url {
    crate::pages::data_url(html).parse().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn strip_actions_are_the_few_it_offers() {
        let a = |s: &str| strip_action(&url(s));
        assert_eq!(a("http://questlog-strip.invalid/local"), Some(StripAction::Local));
        assert_eq!(a("http://questlog-strip.invalid/choose"), Some(StripAction::Choose));
        assert_eq!(a("http://questlog-strip.invalid/app"), Some(StripAction::App));
        assert_eq!(
            a("http://questlog-strip.invalid/server?url=http%3A%2F%2Fnas%3A8780%2F"),
            Some(StripAction::Server("http://nas:8780/".into()))
        );
        for other in [
            "http://questlog-strip.invalid/server",
            "http://questlog-strip.invalid/server?address=nas",
            "http://questlog-strip.invalid/retry",
            "http://questlog-strip.invalid/crash-send",
            "http://questlog-strip.invalid/",
            "https://questlog-strip.invalid/local",
            "http://questlog-strip.invalid:81/local",
            "http://u:p@questlog-strip.invalid/local",
            "http://questlog-shell.invalid/local",
            "http://questlog-strip.invalid.evil.com/local",
            "data:text/html,x",
        ] {
            assert_eq!(a(other), None, "{other}");
        }
        assert!(is_strip_host(&url("https://QUESTLOG-STRIP.invalid/x")));
        assert!(!is_strip_host(&url("http://questlog-shell.invalid/local")));
    }

    #[test]
    fn the_strip_webview_shows_only_its_own_page() {
        let html = page(&[], &Current::Local, false);
        let own = url_of(&html);
        let g = StripGate { expected: Some(own.clone()), html };
        assert_eq!(g.decide(&own), StripNav::Allow);
        assert_eq!(g.decide(&url("http://questlog-strip.invalid/local")), StripNav::Act(StripAction::Local));
        for other in [
            "data:text/html,<h1>strip</h1>",
            "about:blank",
            "http://127.0.0.1:8790/",
            "https://example.com/",
            "mailto:a@b.c",
            "http://questlog-shell.invalid/local",
            "http://questlog-strip.invalid/other",
            "file:///etc/passwd",
        ] {
            assert_eq!(g.decide(&url(other)), StripNav::Block, "{other}");
        }
        assert_eq!(StripGate::default().decide(&own), StripNav::Block, "nothing expected: nothing loads");
    }

    #[test]
    fn page_has_each_workspace_and_marks_the_current_one() {
        let nas = url("http://nas:8780/");
        let other = url("http://10.0.0.20:9000/");
        let html = page(&[nas.clone(), other.clone()], &Current::Team(other.clone()), false);
        assert!(html.contains("href=\"http://questlog-strip.invalid/local\" aria-label=\"This computer\""), "{html}");
        assert!(html.contains("aria-label=\"Team server nas\" title=\"Team server: nas\">NA</a>"), "{html}");
        assert!(html.contains(
            "href=\"http://questlog-strip.invalid/server?url=http%3A%2F%2F10.0.0.20%3A9000%2F\" \
             aria-label=\"Team server 10.0.0.20:9000 (current)\" title=\"Team server: 10.0.0.20:9000\" \
             aria-current=\"true\">20</a>"
        ), "{html}");
        assert_eq!(html.matches("aria-current=\"true\"").count(), 1, "one current button");
        assert!(html.contains("aria-label=\"Add or change a server\""));
        assert!(html.contains("<nav aria-label=\"Workspaces\"><ul>"));
        assert!(html.contains(&format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">")));
        assert!(CSP.starts_with("default-src 'none';") && !CSP.contains("http"), "{CSP}");
        assert!(html.contains("'drop'"), "drops are refused");
        // Each link's action parses back to what it names.
        let href = |label: &str| {
            let i = html.find(&format!("aria-label=\"{label}")).unwrap();
            let start = html[..i].rfind("href=\"").unwrap() + 6;
            let end = start + html[start..].find('"').unwrap();
            strip_action(&url(&html[start..end].replace("&amp;", "&")))
        };
        assert_eq!(href("This computer"), Some(StripAction::Local));
        assert_eq!(href("Team server nas"), Some(StripAction::Server("http://nas:8780/".into())));
        assert_eq!(href("Team server 10.0.0.20"), Some(StripAction::Server("http://10.0.0.20:9000/".into())));
        assert_eq!(href("Add or change"), Some(StripAction::Choose));

        let local = page(std::slice::from_ref(&nas), &Current::Local, false);
        assert!(local.contains("aria-label=\"This computer (current)\""));
        assert!(page(std::slice::from_ref(&nas), &Current::Choosing, false).contains("aria-label=\"Add or change a server (current)\""));
        let busy = page(&[nas], &Current::Nothing, true);
        assert!(busy.contains("<nav aria-label=\"Workspaces\" class=\"busy\" aria-busy=\"true\">"));
        assert!(!busy.contains("(current)"));
    }

    #[test]
    fn initials_for_names_and_addresses() {
        assert_eq!(initials(&url("http://nas:8780/")), "NA");
        assert_eq!(initials(&url("https://team.example.com/")), "TE");
        assert_eq!(initials(&url("http://127.0.0.1:18781/")), "1");
        assert_eq!(initials(&url("http://100.64.0.7:8780/")), "7");
        assert_eq!(initials(&url("http://[fd7a:115c::5]:9000/")), "5");
        assert_eq!(initials(&url("http://x/")), "X");
    }
}

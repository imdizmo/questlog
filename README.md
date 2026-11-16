# Questlog

A small task tracker for a game team on a local network: workspaces, projects, areas,
lists and tasks, with a start/block/review/done workflow and live updates between everyone who
has the page open. One Node process serves the web app, the API and a single SQLite file. It
needs no internet connection at runtime.

## Run it

You need Node 22.13 or newer (the first release with `node:sqlite` unflagged; the project is tested
on Node 26) and pnpm.

```sh
pnpm i && pnpm build && pnpm start
```

`pnpm build` bundles the web app into `dist/web`. `pnpm start` serves it together with the API on
port 8780 (set `PORT` to change it). On start the server prints one URL per network address,
for example `http://10.0.0.20:8780`. Anyone on the same network can open that URL.

For development, `pnpm dev` runs the Vite dev server and restarts the API on changes.

## Install as a desktop app

Questlog also runs as a private, offline desktop app: one window, a bundled Node runtime, and the server listening on
`127.0.0.1` only (nobody else on the network can reach it). Releases for Linux (`Questlog-vX.Y.Z-linux-x64.tar.gz`)
and Windows (`Questlog-vX.Y.Z-win-x64.zip`) are on the GitHub releases page of `imdizmo/questlog`, each with a
`.sha256` beside it. Unpack the archive anywhere and run `Questlog` (`Questlog.exe` on Windows). Windows needs the
WebView2 runtime, which Windows 10 and 11 normally have.

To install it from the Jatify launcher, add this entry to the launcher's `apps.json` (or to your own overlay,
`~/.config/jatify-launcher/apps.json`):

```json
{ "id": "questlog", "name": "Questlog", "tagline": "Plan your game as tasks, lore and a game-data wiki.",
  "description": "A private, offline Questlog: projects, lists, tasks, lore wiki with typed entries, and JSON export for your game.",
  "releases": "imdizmo/questlog", "releaseAsset": "linux-x64.tar.gz", "releaseExe": "Questlog",
  "source": "https://github.com/imdizmo/questlog.git", "branch": "main", "repo": "https://github.com/imdizmo/questlog",
  "memoryMax": "1536M", "by": "Jatify", "singleInstance": true }
```

**Data folder.** The desktop app keeps everything in one folder, separate from any server install:

- Linux: `$XDG_DATA_HOME/questlog` (by default `~/.local/share/questlog`);
- Windows: `%LOCALAPPDATA%\Questlog`.

It holds the database, attachments and covers, `secret.key`, `desktop.json` (the port it uses: 8790 if that was free
on the first start, otherwise another free port, then always the same one) and `logs/server.log` (rotated at 5 MB,
one old copy kept as `server.log.1`). Starting Questlog a second time brings the open window to the front instead.
Closing the window stops the server.

**Connecting to a team server.** The app can also open a Questlog server on your network instead of its own
workspace. The Jatify Launcher sets `JATIFY_TEAM` to the server's address (`host` or `host:port`; the port is 8780 if
you leave it out, and the connection is plain http). Without it, a fresh install asks **Where is your workspace?**:
**this computer** or **a server**, where you type the address. A choice saved in `desktop.json` (`"server": "local"`
or an address) wins over `JATIFY_TEAM`. If the server is down, the app says "Questlog can't reach the server" and
offers **Retry**, **Change server** and **Use this computer**. **Use this computer** is remembered: to go back to the
team server, close Questlog and remove the `"server"` entry from `desktop.json` in the data folder
(`~/.local/share/questlog/desktop.json` on Linux, `%LOCALAPPDATA%\Questlog\desktop.json` on Windows). The workspace on
this computer is separate from the server's: nothing syncs between them. A server that redirects to a different
address opens in your system browser instead of the app window.

**Backups.** Before a new version changes the database, the app saves a copy in `backups/` inside the data folder,
named `jt-<migration>-<YYYYMMDD-HHMMSS>.db`; the newest three are kept. To back up by hand, close Questlog and copy
the whole data folder. To restore, close Questlog and put the copied folder (or a `backups/` file, renamed to `jt.db`
with no `-wal`/`-shm` files beside it) back. If a database was made by a newer Questlog, the app shows an error page
that names the backups folder instead of starting.

**Testing on Windows.** The Windows build is checked for its layout and file headers but has not been run on Windows
by us. If you try it, please check:

1. The window opens and shows the setup screen (first start) or your workspace.
2. Starting `Questlog.exe` again while it is open brings the existing window to the front; no second window opens.
3. Closing the window stops the server: no `node.exe` is left in Task Manager.
4. The data is in `%LOCALAPPDATA%\Questlog` (database, `desktop.json`, `logs\server.log`).
5. After quitting and starting again (and after a reboot), the workspace and its tasks are still there.

**If it does not start on Windows.**

- The exe is not signed yet, so Windows SmartScreen may say "Windows protected your PC". Choose **More info**, then
  **Run anyway**.
- A message box saying WebView2 is missing: install the Evergreen runtime from the link it shows, then start Questlog
  again.
- A window that shows an error page: the page says what failed and names the log. Send
  `%LOCALAPPDATA%\Questlog\logs\server.log` (and `server.log.1` if present) along with a screenshot of the page.

**Build from source.** You need Node and pnpm (as above), Rust with `cargo install tauri-cli --locked --version '^2'`,
and on Linux the WebKitGTK 4.1 development packages. Then:

```sh
pnpm install --frozen-lockfile
pnpm test
scripts/package-desktop.sh v0.1.0 out linux      # out/Questlog-v0.1.0-linux-x64.tar.gz + .sha256
scripts/smoke-desktop.sh out/Questlog-v0.1.0-linux-x64.tar.gz   # Linux smoke test under a private Xvfb
```

`package-desktop.sh` builds the web app, bundles the server (`scripts/build-server.mjs`), builds the window with
`cargo tauri build --no-bundle`, and downloads the Node runtime named in `scripts/node-version.txt` (checked against
nodejs.org's checksums). For Windows, build `Questlog.exe` on Windows
(`cargo tauri build --no-bundle --config '{"version":"0.1.0"}'` in `desktop/src-tauri`, with the release's version) and
pass it in: `QUESTLOG_WIN_EXE=path/to/Questlog.exe scripts/package-desktop.sh v0.1.0 out win`.
Pushing a `vX.Y.Z` tag runs the same steps in GitHub Actions (`.github/workflows/release.yml`) and publishes both
archives.

## First run

1. Open the URL. With an empty database the app goes to **Set up your workspace**: enter a
   workspace name and your own name, email and password. You become the workspace owner.
2. Create a project from the **Lists** page, then areas and lists inside it.
3. Invite people from the gear menu in the top bar: **Members → Invite people**. Pick a role
   (admin, member or observer) and, for members and observers, the projects they should see.
   Then **Create link**. The link is copied and shown once. Send it to the person; it works for
   7 days. Admin links work once. Open links are listed under **Members**, where you can
   disable them.
4. Workspace-wide options (active task slots, week start, feature switches and so on) are under
   **Workspace settings** in the same menu. Only the owner and admins see that menu.

## Host names

The server only answers requests addressed to a name it knows. This stops other web pages from
reaching it through DNS tricks. It knows `localhost`, `127.0.0.1`, `[::1]`, this machine's
hostname, `<hostname>.local` and every address on its network interfaces, each with the port.
If people reach it some other way (a DNS name on your router, a reverse proxy), add those names
with `JT_HOSTS`. It takes a comma-separated list of `host[:port]` values:

```sh
JT_HOSTS=tracker.lan:8780,studio-pc:8780 pnpm start
```

Any other name gets HTTP 421.

## Team server

To share one Questlog over Tailscale, run the server on a machine that is on your tailnet and let people sign in by
their Tailscale device instead of a password. It is off unless you turn it on:

```sh
JT_HOST=100.x.y.z JT_HOSTS=nas:8780 JT_TAILSCALE_AUTH=1 JT_TEAM_FILE=/path/to/team.json pnpm start
```

- `JT_HOST` makes the server listen on one address only. Use the machine's Tailscale address (`100.x.y.z`), so nobody
  outside your tailnet can reach it. Add the name people use to reach it (for example a MagicDNS name) to `JT_HOSTS`,
  as in [Host names](#host-names).
- `JT_TAILSCALE_AUTH=1` turns on sign-in by Tailscale. The server asks the local Tailscale daemon who is connecting;
  `JT_TAILSCALE_SOCKET` sets its socket (default `/var/run/tailscale/tailscaled.sock`).
- Only connections from Tailscale addresses count, and who they are is taken from the connection itself. A request that
  carries proxy headers (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Via`) is never signed in this
  way, so run Questlog directly on the Tailscale address, not behind a proxy.
- `JT_TEAM_FILE` names a shared team list. Questlog writes it at start and after every team change, with each person
  who has a Tailscale login (version 1 format). At start it first takes in people already in an existing file. A file it
  cannot read or does not understand is left as it is.
- `GET /team/whoami` tells you who the server thinks you are.

**Who gets in.** Only members whose account is linked to their Tailscale login are signed in automatically when they
open the page. Anyone else sees a page that says to ask the owner, with a link to the normal password sign-in. People
Tailscale knows but Questlog doesn't show up under **Members → Waiting to join**, where an owner or admin can **Add**
them with a role or **Dismiss** them.

**Linking your own account.** Any member who has a password (the owner too) signs in with it once, then links their
Tailscale login from **My account** (this asks for the password again). After that, opening the page on that device
signs them in. Nobody can set a login for someone else: owners and admins can only unlink people, and only the owner
can unlink the owner. Unlinking someone who was added from **Waiting to join** is safe: they have no password, so their
next visit asks to join again, and adding that request reconnects the same account (same tasks, same history). Logging
out on a Tailscale device signs you straight back in.

## Data and backups

Everything lives in one SQLite database, `data/jt.db` by default. Set `JT_DB` to put it
somewhere else:

```sh
JT_DB=/srv/tracker/jt.db pnpm start
```

To back up, **stop the server first**, then copy the database file. If `jt.db-wal` and
`jt.db-shm` are next to it, copy them too. Copying while the server runs can give you a file
that is half written. To restore, stop the server, put the copied file(s) back and start it
again.

Attachments and covers are stored in the folder named by `JT_FILES` (default next to the database).
**That folder must belong to one workspace only.** At start the server deletes every file in it that
its own database doesn't list, so pointing two workspaces, or any other files, at the same folder
loses data. Back it up together with the database.

## Plans and Stripe

By default there is no billing: every limit is off and everything is unlocked. Setting
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` turns plans on (Free, Plus, Pro; the first switch
starts a 14-day Pro trial). Point a Stripe webhook at `<JT_PUBLIC_URL>/api/billing/stripe-webhook`
and set the price ids you sell as `STRIPE_PRICE_PLUS_MONTH`, `STRIPE_PRICE_PLUS_YEAR`,
`STRIPE_PRICE_PRO_MONTH` and `STRIPE_PRICE_PRO_YEAR`. Without the keys billing goes back to off.
Related settings, described in the areas around this one: `JT_SECRET` (server secret, see Email),
`EMAIL_TRANSPORT` (`log` by default, `smtp` to send, see Email) and `JT_PUBLIC_URL`.

## Email

Questlog sends a few kinds of email: notification round-ups (each person picks a daily
round-up at 8:00 in their timezone, emails within minutes, or none, under **Email notifications** in
the account menu), "your report is done" emails to players who left an address with a user report
(one per address per day, from 8:00 in the owner's timezone), and invite links when you type an
address in the invite dialog.

By default nothing leaves the machine (`EMAIL_TRANSPORT=log`): emails are kept in the outbox,
marked "not sent (log mode)". Admins see the outbox (the newest 200 emails) under Workspace
settings, Email. To send through your mail server:

```sh
EMAIL_TRANSPORT=smtp SMTP_HOST=mail.example.com SMTP_PORT=587 \
SMTP_USER=tracker SMTP_PASS=... SMTP_FROM=tracker@example.com \
JT_PUBLIC_URL=https://tracker.example.com pnpm start
```

- `SMTP_STARTTLS` is on unless set to `false`; with it on, a server that doesn't offer STARTTLS
  gets nothing. The password is never sent unencrypted except to `localhost`.
- `JT_PUBLIC_URL` is where links in emails point (default `http://localhost:<PORT>`).
- Up to 20 emails go out per minute. A failed email is retried after 1, 5, 15 and 60 minutes,
  five tries in all; a permanent refusal (5xx) of the sender, recipient or message is not retried
  (a refused sign-in is, so fixing `SMTP_PASS` lets queued emails through). One email may take at
  most 2 minutes. The outbox keeps the newest 10000.
- While the workspace is disabled nothing is sent and no round-ups are made.

Every email except invites ends with an unsubscribe link (`/email/unsubscribe?t=...`), signed for
that address and kind of email, and carries `List-Unsubscribe` and `List-Unsubscribe-Post` headers so
mail apps can offer one-click unsubscribe. Opening the link only shows a page with an **Unsubscribe**
button (so link scanners change nothing); the button, or the mail app's one-click request, does it.
It needs no sign-in, accepts requests from mail providers' servers (the signed link is the only
credential), and keeps working while the workspace is disabled, since it only ever turns email off.
The host in `JT_PUBLIC_URL` must be one the server answers to (see `JT_HOSTS`).

Report emails go to addresses players typed in, which nobody has checked. They hold only fixed text,
the user report app's name and the task codes (never the report's text or the task's title), and the
workspace sends at most 200 of them a day.

The links are signed with the server secret: `JT_SECRET` (16 characters or more) when set, otherwise a
random key the server writes to `secret.key` next to the database on first start (readable by its
owner only; a damaged file stops the server rather than being replaced). Keep that file
with your backups; with a new secret, links in emails already sent stop working.

## Public pages (switched off)

The Project settings tab that turned this on has been removed, so a project cannot be shared this way from the app at the moment. The pages and their server code are still there; this section describes them for when the tab returns.

A project can be shared as public, read-only pages at `<JT_PUBLIC_URL>/open/<url name>` (Project settings › Public lists; project producers and admins). Anyone who can reach the server can read them, without an account. Before you share a project, check that nothing in it is private.

- **What visitors see:** every list of the project, with its live tasks (archived and deleted tasks never show; lore does). For each task: its title, text, a coarse status, priority, Effort, tags, upvotes, and its owner's display name. Comments show only when "Show comments" is on, and only from comment threads (never blockers or reviews). Visitors never see email addresses, other projects, or the project's own name: they see the display name you pick.
- **Images:** the banner and the gallery image are uploaded like covers. They are public only while the shared project points at them.
- **Visitors' accounts:** visitors who want to upvote or get update emails join as *guests*. Guests have no access to the workspace and use no seat. Joining always answers "check your email". No account exists until the emailed link (valid for 24 hours) is used, so nobody can take an address or find out whether it already has an account: an address that has one gets a short notice instead. At most 100 sign-up emails go out per day for the whole workspace, and they hold fixed text only. In log mode nothing is sent: admins see each confirmation link in Workspace settings › Email and can pass it on by hand. Admins can remove guests under Members.
- **Emails:** followers get a daily or weekly email about new and finished tasks. Admins get a weekly upvote digest on Mondays. Both carry an unsubscribe link.
- **Gallery:** `/open` lists the shared projects marked "List in the gallery".
- **Limits:** public reads are limited to 120 a minute per IP address, and sign-ups to 5 an hour. Behind a reverse proxy every visitor shares the proxy's address.
- **Turning it off:** "Stop sharing" makes every page answer 404 at once. The settings and the URL name are kept. Archiving the project, or disabling the workspace, hides the pages too.

## Discord and Slack

Workspace settings › Discord and › Slack (admins). Discord and Slack call this server, so it must be reachable from the
internet over https under a host name listed in `JT_HOSTS`.

- **Discord** (interactions over HTTP, no bot that stays connected): set the application's interactions endpoint to
  `<public URL>/integrations/discord/interactions`. Requests are checked against the application's public key (Ed25519,
  at most 5 minutes old). `/bug` and `/card` make a task in the list picked for that channel. "Register commands with
  Discord" is the only call to Discord's API, made when you click it. Each project can post its news (new and finished
  tasks, comments, new milestones) to a channel webhook. Karma roles are saved but do nothing yet: they need a
  connected bot.
- **Slack:** project news goes to one incoming webhook for the projects you tick. For `/addcard`, create a slash command
  with the request URL `<public URL>/integrations/slack/commands` and save the signing secret, your Slack workspace id
  (`T…`) and a bot token with the `users:read.email` scope. Commands from other Slack workspaces are refused. The task
  is made as the member whose email matches the Slack user's confirmed email, in the list you pick, and lands in their
  bookmarks. Slack guests, bots and people from other teams get a refusal and nothing is created.
- **Secrets** (bot tokens, signing secret, webhook URLs) are stored encrypted (AES-256-GCM) with a key derived from the
  server secret (`JT_SECRET` or `secret.key`, see Email). With a new server secret they read as "not set" and must be
  entered again.
- **Limits:** each endpoint takes at most 40 requests per 5 seconds per IP address, counted before the signature
  check. Behind a reverse proxy every caller shares the proxy's address, so unsigned junk can slow genuine Discord or
  Slack traffic; limit those paths at the proxy if that matters.
- **Outbound calls** go only to a fixed list of hosts (`api.hacknplan.com`, `api.stripe.com`, `discord.com`,
  `hooks.slack.com`, `slack.com`). News is posted from a queue every few seconds (at most 20 posts at a time, failed posts are tried again
  up to five times), never while a request waits, and not at all while the workspace is disabled.

## Disabling and deleting a workspace

The owner can disable the workspace under Workspace settings, Danger Zone. Nothing is deleted:
nobody but the owner can sign in, and the API, MCP, user reports, integrations and public
lists stop answering until the owner signs in and reactivates it. With a paid plan the
subscription ends with the current billing period.

There is no delete button. To delete a disabled workspace for good, stop the server and run

```sh
pnpm start --delete-workspace --confirm "<workspace name>"
```

This removes the attachments and covers the database knows about, one by one, then the database
(with its `-wal` and `-shm` files). Any other file in the attachment folder is left alone and
counted; the folder itself goes only if it ends up empty. Use the same `JT_DB` and `JT_FILES` as
the server. It refuses while the server is running or the workspace is still active.

## Game wiki and export

Each project has a **Wiki** (sidebar): lore entries with an entry type (Item, Creature, Recipe…), typed fields,
typed links between entries (drops, sells…) and checks. **Entity types** in the Wiki's header edits types and link
kinds; an empty project offers a small starter set (Character, Creature, Faction, Place, Item, Quest, History,
Storyline and six links). The RPG extras (recipes, abilities, shops, dungeons, weapon and armour types…) are added
from the Wiki's first page or under Entity types.

Tasks show an id such as `LH-127`: the project's initials and the task's number. Links and `$code` references in
text keep the short code underneath.

The game gets the data as JSON:

- The Wiki opens on one tile per entity type (entry type). A entity type's page shows what was made from it and starts
  a new one from **Empty**, a **template** (saved starting values and links) or a copy of an existing entry. The
  new-entry page has the values as buttons and sliders, the links as pickers, and a preview.
- An entity type also holds **page headings**: a new page starts with them, so there is something to fill in.
- **Places** nests places by their "located in" link and lists what is found in each. **Timeline** lists everything
  with a Year, by Era. A **Storyline** has a storyboard: frames in order, each an entry of its own. These three read
  the starter pack's keys (`location`, `located_in`, `found_in`, `year`, `era`, `storyline`, `frames`).
- A storyline's **Open as a flow** puts its frames on a board as picture cards joined by lines. Draw more lines to
  branch and label them as the choices. **Play** walks the story from the first frame (the star). A line's label can
  hold a condition and changes after its text: `Pay the toll {if gold >= 5} {set gold -= 5}`, `{if seen The gate}`;
  starting values are under **Variables**, and `{gold}` in a frame's text shows a value. A card of another storyline
  is a jump into that storyline's flow. Entries dragged from the **Cast** panel onto a frame are linked to it, and
  a frame's audio attachments get a player in Play.
- **Export JSON** in the Wiki's header downloads `<project>-gamedata.json` (anyone who can see the project,
  observers included).
- From scripts and the engine: `GET /api/wiki/<project id>/export` with `Authorization: Bearer <API token>`.
  A read token is enough; a token confined to other projects gets `404`.
  - `?includePages=1` also exports untyped lore pages (only typed entries by default).
  - `?strict=1` answers `422 {"error": "checks_failed", "checks": [...]}` instead of a file while any check fails.
  - More than 50,000 exported entries, 200,000 links, or 128 MB of field values, entry text and link properties
    (`EXPORT_LIMITS` in `server/wikiExport.ts`): `413 too_large`, refused before anything is read.

Everything in the file is valid: invalid values, images that are no longer attached, and links or references to
missing, deleted or wrong-type entries (or, without `includePages`, to plain pages) are left out and listed in
`checks`, the same checks as the Wiki's badge. At most 1,000 checks are listed (file and `422` body); over that,
`checksTotal` (the full count) and `checksTruncated: true` follow `checks`, and are absent otherwise. Links to a
trashed entry are left out without a check. Values of hidden fields are left out without a check: hiding a field retires it on purpose. Entries, types and fields are identified by keys that renaming never
changes. Task links ("works on") are not part of the game data. The format is documented with the Unity sample in
[`integrations/unity/QuestlogData`](integrations/unity/QuestlogData/README.md), whose editor menu
**Questlog → Pull game data** downloads the file into `Assets/QuestlogData/`. Changing an entry's key by hand (API only) does not rewrite references to the old key: they show up as `broken_ref` checks.

## Tests

```sh
pnpm test        # unit and API tests (Vitest)
pnpm typecheck   # TypeScript, no output files
```

The browser tests build the app, start a server on port 8781 with a scratch database in
`~/.cache/gametracker/scratch/e2e.db`, and drive the system Chromium at `/usr/bin/chromium` headless
(set in `playwright.config.ts`; change `executablePath` there if yours lives elsewhere). They are memory-hungry, so
run them under a memory cap:

```sh
systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 pnpm e2e
```

Each spec file sets up the workspace itself if the database is empty, so any one of them can be
run alone (`pnpm e2e team.spec.ts`). Delete `e2e.db` (and its `-wal`/`-shm` files) afterwards if
you want the space back.

## Git commit references

Workspace settings › GitHub, › GitLab and › BitBucket (admins). "Generate webhook URL" makes a URL (and, for GitHub and
GitLab, a secret) that is shown once; add it as a push webhook in the repository (self-hosted GitLab and Gitea work too).
The git host calls this server, so it must be reachable from where the host runs.

- **In a commit message:** `$11a` (a task's code) adds "referenced in commit <sha> by <author>" with a link to the task's
  history. Codes inside links are ignored. Our own command words: `closes $11a` marks the task done, `review $11a` opens a
  review thread. Commands run as the person who created the webhook, with their rights; a task they can't see or may not
  change is skipped silently, and so is everything when they are disabled or no longer a member. A webhook can be limited
  to one project.
- **Checks:** GitHub `X-Hub-Signature-256` (HMAC-SHA256 of the body), GitLab `X-Gitlab-Token`, BitBucket a secret inside
  the URL (only its hash is stored). All timing-safe. GitHub and GitLab secrets are stored encrypted like the chat
  integrations' secrets. Bodies over 1 MB are refused, a push counts at most 50 commits and 20 references per commit,
  each hook takes 60 requests a minute (120 a minute per IP address before the hook is looked at), and a delivery id is
  handled once.
- **Steam:** the Steam tab is a note only; Steam reviews are not connected.
- **Replays and proxies:** a commit a hook has already handled (a branch merged later, a replayed body) is ignored, so its
  commands never run twice. The BitBucket secret is part of the URL path, so a reverse proxy's access log will record it:
  log without the path or treat that log as secret. Behind a proxy all callers share one per-IP allowance (120 a minute).

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
one old copy kept as `server.log.1`) beside `logs/desktop.log` (the app's own log, rotated the same way). Starting Questlog a second time brings the open window to the front instead.
Closing the window stops the server.

**Connecting to a team server.** The app can also open a Questlog server on your network instead of its own
workspace. The Jatify Launcher sets `JATIFY_TEAM` to the server's address (`host` or `host:port`; the port is 8780 if
you leave it out, and the connection is plain http). Without it, a fresh install asks **Where is your workspace?**:
**this computer** or **a server**, where you type the address. A choice saved in `desktop.json` (`"server": "local"`
or an address) wins over `JATIFY_TEAM`. If the server is down, the app says "Questlog can't reach the server" and
offers **Retry**, **Change server** and **Use this computer**. **Use this computer** is remembered. The workspace on
this computer is separate from the server's: nothing syncs between them. A server that redirects to a different
address opens in your system browser instead of the app window.

**Where you are working.** The window title says it: `Questlog · Team server (<host>)` or `Questlog · This computer`
(plain `Questlog` while it asks or shows an error). The **Workspace** menu switches: **Use the team server** (only when
`JATIFY_TEAM` or a server address you typed gives one; a typed server is remembered across **Use this computer** and
still wins over `JATIFY_TEAM`), **Use this computer**, and **Change server…** (the chooser). A switch saves the choice
in `desktop.json` (`~/.local/share/questlog/` on Linux, `%LOCALAPPDATA%\Questlog\` on Windows) and the window
restarts (the local server stops first); no data is moved or deleted.

**Crash reports.** If Questlog ends unexpectedly (the app itself crashes, the local server stops on its own, also
while starting, or the app is killed), the next start asks "Questlog closed unexpectedly. Send the report to the
team?" with **Send**, **Don't send** and **See what is sent**. After the local server stops, closing the window still
counts as a crash. A database from a newer Questlog is not a crash. This only happens when the Jatify Launcher passes
a team server (`JATIFY_TEAM`); closing the window at the question counts as **Don't send**. The report is a zip of the logs plus
`report.json` (tool, version, OS, and the memory limit if the launcher passes `JATIFY_MEMORY_MAX`), at most 20 MB. It
goes to the team's library service on port 8781 of the team host, only to a private or Tailscale address, and only
when you choose Send. Errors inside the page that do not end the app, and the team server's own errors (they are in
the server's logs), are not reported. A `running` file in the data folder says whether the last run ended cleanly:
it is there while Questlog runs and removed by a clean exit. Deleting it is harmless (the next start just does not ask).

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
  `%LOCALAPPDATA%\Questlog\logs\desktop.log` and `server.log` beside it (and the `.1` copies if present) along with a screenshot of the page.

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
- `GET /team/whoami` tells you who the server thinks you are. When the server runs as part of a Jatify team server,
  set `JATIFY_TEAM_SERVER` to that team server's address and the answer includes it as `teamServer`.

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

### Team members API

Other Jatify tools on the tailnet (the Jatify Launcher's Server tab) list and manage the team over HTTP. The caller is
their Tailscale identity, worked out the same way as `/team/whoami`. Anyone not on the team gets 403 `not_member`. Any
member can read the member list. Only the owner and admins can see join requests and change anything.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /team/members` | any member | `{"members":[{"login","name","role","since","lastSeen"}]}`: enabled people only; `login` is null for password-only people |
| `GET /team/requests` | owner, admin | `{"requests":[{"login","name","at"}]}`, newest first |
| `POST /team/members` `{"login","name"?,"role"}` | owner, admin | 201 with the entry. Re-adding a removed (disabled) login re-enables them with the role (200). 409 `already_member` if they are already on the team |
| `PATCH /team/members/<login>` `{"role"}` | owner, admin | 200 with the entry |
| `DELETE /team/members/<login>` | owner, admin | 204. Disables the person: their sessions end and they leave `team.json`; their history stays |
| `POST /team/requests/<login>/approve` `{"role"}` | owner, admin | 201 with the entry |
| `POST /team/requests/<login>/deny` | owner, admin | 204 |

- `lastSeen` is their latest sign-in, taken from their open sessions, or null. `since` is when their account was made.
- Without a `name`, someone added by `POST /team/members` gets the display name from their join request, if there is
  one, else their login.
- Errors are `{"error": code, "message": text}`, and the message can be shown as is.
- An unknown member or request is 404 `not_found`; a route this server doesn't have is 404 `no_route` (an older server).
- Writes must send `X-Jatify: 1` and `Content-Type: application/json` (also on DELETE and deny, with an empty body) and
  must not send an `Origin` header. Anything else gets 403 `cross_origin`, so a web page on the tailnet can't change the
  team.
- Roles follow the Members page: the same seat limits, and observers only on plans that include them. On top of that:
  - Ownership never moves here: role `owner` gets 409 `owner_transfer`. It moves in Questlog's settings (Danger zone).
  - The owner can't be changed, removed or relinked here: 409 `last_owner`.
  - Through this API an admin only adds, changes and removes members and observers. Making or unmaking an admin needs
    the owner (403 `forbidden`). This limit is for the API only: on Questlog's own Members page admins manage roles as
    before.
- While the workspace is disabled, these routes answer 423 `workspace_disabled`. `/team/whoami` keeps working.

**`JATIFY_ADMIN_TOKEN`.** When this is set to a non-empty value, a request from loopback (`127.0.0.1` or `::1`) with
the header `X-Jatify-Token: <value>` acts as the owner. A request through a proxy (any of the proxy headers above)
never qualifies. Unset or empty, this way in is off. This is how a launcher on the same machine manages a local server
without Tailscale. Loopback only means "from this machine", so two caveats:

- Behind a reverse proxy or any TCP forwarder on the same machine (`tailscale serve --tcp`, `socat`, `ssh -L`), every
  request reaches Questlog from loopback. A forwarder sends no proxy headers, and a proxy may strip them, so there the
  token is the only check: keep it secret and long.
- Inside Docker's bridge network, the host's requests arrive from the bridge gateway, not loopback, so the token is
  never accepted there. Use the Tailscale identity instead.

One exception: the first setup (`POST /api/setup`). With `JATIFY_ADMIN_TOKEN` set, setup needs the matching
`X-Jatify-Token` from every caller, on loopback or not, and anything else gets 403 `setup_token`. So a fresh server in a
container can be set up over the tailnet by whoever holds the token, and nobody else can claim it first. Everywhere
else the token stays loopback-only. Without the variable, setup works as before (whoever opens the page first).

The owner is linked to a Tailscale login at setup when that login is proven: with `JT_TAILSCALE_AUTH=1`, the Tailscale
person on the connection (as `/team/whoami` sees them); else, from loopback with a valid token, the optional body field
`tailscaleLogin` (never with `JT_LOOPBACK_TRUST=0`, as in the Docker image). The team file is written right away. Any
other `tailscaleLogin` is ignored. Once a workspace exists, setup answers 409 `already_setup` whatever the token.

## Run a Questlog server with Docker

The `Dockerfile` at the top of the repository builds an image with the server and the web app on Node's slim image (no
dev tools, no secrets). It runs as an unprivileged user and keeps everything in `/data`: the database
(`/data/questlog.db`), attachments (`/data/files`) and the server's secret key. Put `/data` on a volume.

```sh
docker build -t questlog-server .
docker volume create questlog-data
docker run -d --name questlog -p 8780:8780 -v questlog-data:/data \
  -e JT_HOSTS=myserver:8780 -e JATIFY_ADMIN_TOKEN=<a long random value> questlog-server
```

- `JT_HOSTS` must list every name and port people type in the browser ([Host names](#host-names)). Inside the
  container the server only knows its own names, so without it every request from outside gets 421. If you publish a
  different port (`-p 9000:8780`), list that port (`myserver:9000`).
- Set up the workspace with the token (see [`JATIFY_ADMIN_TOKEN`](#team-members-api)); the Jatify Launcher does this for
  you. By hand:

  ```sh
  curl -H 'Content-Type: application/json' -H 'X-Jatify-Token: <token>' \
    -d '{"workspaceName":"Studio","name":"You","email":"you@example.com","password":"..."}' http://myserver:8780/api/setup
  ```

- The image has a health check on `/healthz` (`docker ps` shows `healthy`). Stopping the container stops the server
  cleanly. With podman or buildah, build with `--format docker`: their default OCI format drops the health check.
- Backups: set `JT_BACKUP_BEFORE_MIGRATE=1` and the server copies the database into `/data/backups` before it applies an
  update's migrations. For your own backups, stop the container and copy the volume ([Data and backups](#data-and-backups)).
- Settings are the environment variables of this README (`PORT`, `JT_HOSTS`, the email and Stripe ones and so on).
  `JT_DB`, `JT_FILES`, `JT_HOST=0.0.0.0`, `PORT=8780` and `JT_LOOPBACK_TRUST=0` (see below) are set in the image.

With Compose:

```yaml
services:
  questlog:
    build: .
    ports: ["8780:8780"]
    volumes: ["questlog-data:/data"]
    environment:
      JT_HOSTS: myserver:8780
      JATIFY_ADMIN_TOKEN: ${JATIFY_ADMIN_TOKEN}
      JT_BACKUP_BEFORE_MIGRATE: "1"
    restart: unless-stopped
volumes:
  questlog-data:
```

**With Tailscale.** Sign-in by Tailscale needs each caller's real Tailscale address and the Tailscale daemon's socket.
The recommended way is host networking on a machine that runs Tailscale, with the host's socket folder mounted:

```yaml
services:
  questlog:
    build: .
    network_mode: host
    volumes:
      - questlog-data:/data
      - /var/run/tailscale:/var/run/tailscale
      - /srv/jatify-team:/team
    environment:
      JT_TAILSCALE_AUTH: "1"
      JT_HOSTS: myserver:8780
      JT_TEAM_FILE: /team/team.json
      JATIFY_ADMIN_TOKEN: ${JATIFY_ADMIN_TOKEN}
    restart: unless-stopped
volumes:
  questlog-data:
```

- The socket must be readable by the container's user (uid 10001). Set `JT_TAILSCALE_SOCKET` if it lives elsewhere.
- Add the MagicDNS name and port to `JT_HOSTS`.
- For the team file, mount its **folder**, not the file, as above. Questlog replaces the file by writing a new one beside
  it and renaming it, which a single-file mount does not allow. The folder must be writable by uid 10001.
- `JT_HOST` can be the machine's Tailscale address so nobody outside the tailnet reaches the server. The health check
  asks `127.0.0.1`, so it then reports unhealthy; leave `JT_HOST=0.0.0.0` if you rely on it.
- On Docker's default bridge network, callers arrive from the bridge, not from their Tailscale address, and are never
  recognised.

A Tailscale sidecar container also works, but only with kernel networking: the `tailscale/tailscale` image defaults to
userspace networking, which hands every tailnet caller to Questlog from `127.0.0.1`. Set `TS_USERSPACE=false`, give it
`/dev/net/tun` and `cap_add: [NET_ADMIN]`, run Questlog with `network_mode: service:tailscale`, and share the socket
through a named volume (`TS_SOCKET=/var/run/tailscale/tailscaled.sock`, the volume mounted at `/var/run/tailscale` in
both), not a host path.

In a container the members-API token is off (the image sets `JT_LOOPBACK_TRUST=0`), so manage members over Tailscale
as the owner. `JT_LOOPBACK_TRUST=0` means a loopback caller is never trusted, because in a container `127.0.0.1` can be
a forwarded remote caller: `JATIFY_ADMIN_TOKEN` then never acts as the owner on `/team/*`, and setup ignores the body
`tailscaleLogin`. The token is still required for the first setup, and the Tailscale link at setup still works.

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

## Project boards

**Vision > Project board** makes a board for a project, shown as frames: one frame per area side by side, the lists
stacked inside it, and each list's open tasks as cards in "waits for" order (what a task waits for comes first), six
to a row, with subtasks after their parent. Only "waits for" (dashed, accent colour) and "subtask" arrows are drawn.
A board shows only the project of the task it belongs to.

- **It follows the project** while it is open: new tasks, lists and areas appear in their frame; done, archived and
  deleted tasks leave; a task moved to another list moves into that frame; renames update. Positions you dragged are
  kept. Undo never undoes what the board did by itself.
- **Zoom out** for the overview: each list shows its name and "N tasks left", and thick arrows count the "waits for"
  links between lists. Zoom in for the tasks and their arrows.
- **Drop to move.** Drop a task card into another list's frame to move the task there, or a list onto another area to
  move the list. A move the project refuses goes back with a message; undoing a drop moves the task back.
- **Draw arrows.** Hover or select a task to see its handles, drag from one to another task and choose "It waits for
  it", "It is its subtask" or "Only a line" (waiting and subtasks are saved on the tasks, so they show everywhere).
  From the keyboard, use the toolbar's **Connect to…**. "It waits for it" needs dependencies on (Settings >
  Features): while they are off, an admin's first use turns them on for the workspace ("It waits for it (turns on
  dependencies)"); anyone else is told an admin can turn them on in Settings.
- The project's area and list frames and its header follow the project: their names can't be edited on the board, and
  they can't be deleted there (delete the list or area from the project instead).
- A project board made with the older tree layout gets **Arrange as frames** in its menu: one undo step, keeping your
  notes and arrows.

## Game wiki and export

Each project has a **Wiki** (sidebar): lore entries with an entry type (Item, Creature, Recipe…), typed fields,
typed links between entries (drops, sells…) and checks. **Entity types** in the Wiki's header edits types and link
kinds; an empty project offers a small starter set (Character, Creature, Faction, Place, Item, Quest, History,
Storyline and six links). The RPG extras (recipes, abilities, shops, dungeons, weapon and armour types…) are added
from the Wiki's first page or under Entity types.

### Writing lore

Lore (wiki entries and lore pages) is written in a live-preview editor. Headings, bold, italic, code, bullets,
checklists (tick them in place), quotes, task codes, @mentions, #tags and your own images show formatted. The Markdown
marks are hidden until needed: heading and title marks show while the caret is anywhere on that line, other marks
while the caret touches them. Lore keeps your exact Markdown: only your own typing, the formatting bar, shortcuts and
ticking a checkbox change the text, and opening and saving without edits stores it byte for byte.

- A formatting bar offers Heading, Bold, Italic, List, Checklist, Quote and Link. Shortcuts: Ctrl+B, Ctrl+I and
  Ctrl+Alt+1/2/3 for heading levels. The `/` menu and the reference pickers work as in the task editor.
- Ctrl+Enter saves, Esc cancels, and focus mode gives the text the whole window.
- Tasks keep the plain editor. If the lore editor can't load, the plain editor takes over.
- Limits: numbered lists show their raw numbers, and Enter in the middle of a numbered list adds a plain line (no
  renumbering).

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

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

**The workspace strip.** A narrow column at the window's left has one button per workspace: **This computer**, each
team server Questlog knows (`JATIFY_TEAM`, the server you typed, and the one **This computer** replaced) and **+**
(add or change a server: the chooser). The open one is highlighted; hover a button for its server's address. A click
switches the same way the Workspace menu does (saved in `desktop.json`, the window restarts). Keyboard: **F6**
(Workspace › Go to the workspace strip) moves the focus there, ↑/↓ move between buttons, Enter switches, Esc goes back
to the page. Every page also says it in the top bar, under the workspace name in the workspace switcher: **This
computer** or **Team: <host>**; and **New project** says where the project goes. The strip belongs to the app, not to the server's page: it is a separate view with its
own page, and nothing a server's page does can switch servers. So the strip and the window title are what to trust
about where you are; the switcher's line is the server's own label for itself. The strip remembers at most three team servers
(`JATIFY_TEAM`, the typed one and the one before it): typing a fourth forgets the oldest typed one.

**Stopping.** SIGTERM, SIGINT and SIGHUP (e.g. `systemctl --user stop` of the Launcher's service) close Questlog
the normal way: the local server is stopped and the next start does not ask about a crash.

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

**Suggestions.** When Questlog knows a team server and the team's library service knows you as a member, the top bar
has a **Suggestion** button: write what to improve, fix or add, add screenshots if you like (PNG or JPEG, up to ten),
and press **Send**. It goes to the team's library service (port 8781 of the team host) with your name, the version of
Questlog and the pictures, nothing else. In **This computer** the local server sends it on from your computer, only to
a private or Tailscale address; a team server's page (with `JATIFY_TEAM_SERVER` set) sends it straight there.

**Assets.** Each project has an **Assets** page (`/assets`): pictures, 3D models, maps and concepts that Questlog
keeps its own copy of, with a link back to where each came from. **Add** takes pictures (PNG, JPEG, WebP) and
single-file `.glb` models from your computer, a picture or `.glb` from a URL (the server downloads it from a public
address and keeps it), and, when Questlog knows a team server whose library service is version 0.7.0 or later, pictures
from **Asset Shelf** packs and from **Groundwork** maps and props (only the picture and a link back come in, never the
model or map). Open an asset to see it big, turn a `.glb` in the 3D viewer, tag it, or use its picture on a wiki entry.

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
3. Invite people from the workspace menu (the workspace switcher at the top left › **Workspace settings, people, look…**): **Members → Invite people**. Pick a role
   (admin, member or observer) and, for members and observers, the projects they should see.
   Then **Create link**. The link is copied and shown once. Send it to the person; it works for
   7 days. Admin links work once. Open links are listed under **Members**, where you can
   disable them.
4. Workspace-wide options (week start, feature switches and so on) are in the same menu, see
   [The workspace menu](#the-workspace-menu). Only the owner and admins see those sections.

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
  - Ownership never moves here: role `owner` gets 409 `owner_transfer`. It moves in Questlog's workspace menu (Disable workspace).
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

## Translation (English ↔ Italian)

Questlog can translate task text, comments and Lore pages between English and Italian on your own server, so each
person reads in their own language. It is off by default and needs the **language pack**, a separate download
(about 55 MB, the same file for every platform): `questlog-translate-models-vX.Y.Z.tar.gz` with a `.sha256`, from the
release page. Nothing is fetched from the internet and no text leaves the server. Desktop builds do not include it.

- **Server archive:** check the download (`sha256sum -c questlog-translate-models-vX.Y.Z.tar.gz.sha256`), then unpack it
  in the folder that holds `server/`: `tar xzf questlog-translate-models-vX.Y.Z.tar.gz`. That makes `models/translate/`
  beside `server/`. Restart the server. `JT_TRANSLATE_PACK` points at a different `models/translate` folder.
- **Docker:** the image has no models. Fill a volume once and mount it at `/app/models`:

  ```sh
  docker volume create questlog-models
  docker run --rm -v questlog-models:/m -v "$PWD":/in:ro alpine \
    tar xzf /in/questlog-translate-models-vX.Y.Z.tar.gz -C /m --strip-components=1
  docker run -d ... -v questlog-models:/app/models:ro questlog-server
  ```

  With Compose, add `questlog-models:/app/models:ro` to the service's volumes and declare the volume.
- Then switch **Translation** on in the workspace menu → Features (owner or admin). Without the pack the switch says what to install and
  everything else works as before.

The engine loads on first use, one direction at a time (about 400 MB of memory while it runs) and is released after 5
idle minutes. A paragraph takes well under a second on a small server. Licences: [NOTICE.md](NOTICE.md).

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

Attachments, covers and asset copies are stored in the folder named by `JT_FILES` (default next to the database).
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
marked "not sent (log mode)". Admins see the outbox (the newest 200 emails) in the workspace
menu under Connections › Email sending. To send through your mail server:

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
- **Visitors' accounts:** visitors who want to upvote or get update emails join as *guests*. Guests have no access to the workspace and use no seat. Joining always answers "check your email". No account exists until the emailed link (valid for 24 hours) is used, so nobody can take an address or find out whether it already has an account: an address that has one gets a short notice instead. At most 100 sign-up emails go out per day for the whole workspace, and they hold fixed text only. In log mode nothing is sent: admins see each confirmation link in the workspace menu under Connections › Email sending and can pass it on by hand. Admins can remove guests under Members.
- **Emails:** followers get a daily or weekly email about new and finished tasks. Admins get a weekly upvote digest on Mondays. Both carry an unsubscribe link.
- **Gallery:** `/open` lists the shared projects marked "List in the gallery".
- **Limits:** public reads are limited to 120 a minute per IP address, and sign-ups to 5 an hour. Behind a reverse proxy every visitor shares the proxy's address.
- **Turning it off:** "Stop sharing" makes every page answer 404 at once. The settings and the URL name are kept. Archiving the project, or disabling the workspace, hides the pages too.

## Discord and Slack

Workspace menu › Connections › Discord and › Slack (admins). Discord and Slack call this server, so it must be reachable from the
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

## AI assistants (MCP)

Workspace menu › Connections › AI assistants (MCP). AI tools that speak MCP connect to `<server URL>/mcp` (JSON-RPC over
HTTP) with a personal API token sent as `Authorization: Bearer <token>`. The tools act as the token's owner and never
exceed the token: a read token only reads, and a token confined to projects sees only those.

- **Writing:** create and change tasks, comments, Hand, lists, milestones and time, and `create_project` (an admin-role
  write token whose owner may create projects; optional `visibility` and `template`).
- **Deleting** needs a personal write token created with **May delete** (API tokens › New personal token). It is off by
  default, and every token made before it existed cannot delete. On top of it the owner's own rights apply as in the
  app (observers cannot delete, guarded lists only by their guardians). The same holds for the command API, see below.
  - `delete_cards`: up to 100 tasks per call, all or none. A soft delete: they go to Archive › Deleted tasks and can be
    restored there.
  - `delete_deck`: removes the list for good (it cannot be restored); its tasks go to Archive › Deleted tasks. Needs
    `confirm: true`.
  - `delete_milestone`: removes the milestone for good; its tasks stay and lose the milestone. Needs `confirm: true`.
- Every change goes through the same commands as the app, so it shows up live and in the task history.
- `list_assets` lists the Assets library of the projects the token can see (name, kind, what it is for, source and
  link back); the picture itself is at `pictureUrl` for a signed-in session.
- **Vision boards:** `get_vision_board` lists a task's board: its nodes (tasks with their titles, notes, frames, ...)
  with position, size and frame, and its lines. `edit_vision_board` changes it like a person would, up to 200
  operations per call, all or none: `add_task` (at `x`,`y`, else beside the last placed node), `move` (position and
  optionally size; a node dropped fully inside a frame goes into it), `remove` (takes a node and its lines off the
  board; the task itself stays), `add_line` and `remove_line`. It needs a write token, works only where its owner may
  edit the board (not on locked boards, nor read-only ones they didn't make), and makes the board if the task has none.
  People with the board open see the change at once. Don't write a board's stored document directly: while anyone
  has it open, the server keeps its own copy and overwrites the change.

### "May delete" on the command API

A personal token without **May delete** cannot delete through `/dispatch/...` either; the call is refused with
`403 {"error":"token_cannot_delete","data":{"command":…,"message":"This token can't delete. Create a token with \"May delete\" ticked."}}`
and nothing changes. People signed in to the app are not affected, and neither are org (integration) tokens, which
delete as their role and access allow. Commands that count as deleting:

- `cards/update` and `cards/bulkUpdate` with `visibility: "deleted"` (archiving and other edits stay allowed)
- `decks/delete`, `projects/delete`, `milestones/delete`, `milestoneZones/delete`, `presets/delete`,
  `visionBoard/deleteBoard`, `timeTracking/delete`, `cards/removeFile` (an attachment)
- `wiki/deleteType`, `wiki/deleteFamily`, `wiki/deleteLinkKind`, `wiki/removeLink`, `wiki/pruneValues` (drops hidden fields' values)
- `journeys/set` with no steps (removes the list's journey)
- `sprints/archiveConfig` (one way: nothing un-archives a run config, and it makes no more runs)

A token's own rows stay open to it: deleting a saved search (`search/delete`), removing a reaction, a watch, a
bookmark or a Hand card. Archiving a project (`projects/update isArchived`) is not deleting, since it can be undone.

## Disabling and deleting a workspace

The owner can disable the workspace in the workspace menu under Disable workspace. Nothing is deleted:
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

## The sidebar, the tabs and the workspace switcher

**The sidebar.** At the top a find box: typing filters the tree below as you go and keeps the parents of what matches
(the match is marked); **Enter** takes the words on to **Ctrl+K**, which also searches tasks; Esc empties it. Then the
main pages: **Home**, **My tasks**, **Inbox** (with its count), **Overview**, **Milestones**, **Wiki**, **Assets** and
**Activity**, as a list or as an icon row (the small button at the
list's bottom right switches). Then your saved filters, and one folding tree per project: its areas (when it has more
than one), its lists with a ring for how much is done and the number of open tasks, and its **Wiki** with the entries
grouped by type (at most 50 per type; "N more" opens the type). At the bottom, quick actions: **New task**, **New
list**, **New wiki entry**, **New milestone** and **Collapse**. Each opens a small box that says where the new thing
goes: the open list, area or project, else the project or area you clicked last in the tree, else your first project.
Collapsed, the sidebar is a rail of icons: open and find at the top, the main pages (Inbox keeps its count), one tile
per project that opens its lists beside the rail, and the quick actions; every icon names itself on hover. The
sidebar, the folds and the main pages' shape are kept per person, on the server, so they follow you to other devices.

**Tabs.** They sit in the top bar right beside the workspace switcher. Each tab is one page with its own back and
forward (the browser's buttons go back and forward in the open tab). A plain click opens a page in the current tab;
the **↗** on a sidebar row, a middle click or Ctrl+click (⌘-click on a Mac) opens it in a new tab behind. Double-click
a tab to pin it; × or a middle click closes an unpinned one. **Home** is pinned first and stays home: what you open
from it opens in a tab of its own (or the tab already showing it). At most 12 tabs: opening one more closes the oldest
unpinned one, and a note says which. **+** opens a New tab page with places to start and the pages you opened
lately. Only the tab you look at is loaded; the others keep where they were scrolled. **←** and **→** beside the
tabs go back and forward in the open tab; Back on a tab's first page returns to the tab it was opened from. Each window
keeps its own tabs (a reload comes back to them); a new window starts from the tabs you had last (per person, on the
server). On a focused tab: ←/→ move, Enter shows it, Delete closes it, Shift+P pins it. Keys: **Alt+1…8** a tab,
**Alt+9** the last one (not while typing, and not on a Mac); in the desktop app also **Ctrl+T** (new
tab), **Ctrl+W** (close) and **Ctrl+Tab** / Ctrl+Shift+Tab (next and previous); a browser keeps those for its own tabs.

**The workspace switcher** (top left) shows the workspace's name and where it is kept (**This computer** or **Team:
<host>**). Its menu lists this workspace, **Workspace settings, people, look…** (the workspace menu below) and, while
the vision board feature is on or boards exist, **Vision boards** (the free canvases, still at `/vision`). Other
workspaces are switched in the desktop app's strip at the window's left; a page never switches them.

**Per-person preferences** are kept by the server (`GET /api/prefs`, `PUT /api/prefs/<key>` with `{ "value": … }`;
a person's own only, at most 32 keys of 32 KB). While the server cannot be reached the page keeps them in the browser
and sends them on the next time it loads.

## Home

Home is the vision board of the whole workspace (**Shift+4**). A painted picture fills the page; on it **Welcome back**,
**Recently worked on** (the tasks and wiki pages you changed or commented on lately, newest first, each opening in a
tab of its own; the arrow folds it away into a clock icon) and a canvas of your projects, their areas (when a project
has more than one), their lists with a ring and the open count, and, when you ask for them, the lists' quests with
their status. Its lines are the links Questlog already has: a project has areas, an area has lists, a list has quests;
a dashed line is "this locks that" (between two quests, or between their lists while quests are hidden). Hover a node
to light up its lines and neighbours; click it to open it in its own tab.

- **View** (the bar at the left): **Web** lets the nodes float around their project (drag anywhere to move the
  picture); **Tree View** lays them out project → areas → lists → quests.
- **Cards**: Projects, Areas, Lists or Quests (or **All**, or none) open into cards in place, like the old vision
  board's scene cards: a picture, the title, a line of text and tags. A quest card shows its own words, its number,
  effort, priority, status and list; a list card its ring and first open quests. In the Web view the pills around a
  card move to the nearest free spot, so nothing overlaps; in Tree View quest cards sit three across.
- The **gear** picks the picture (Ember forest, Fog coast, Night ruins, Moss hollow) and puts the links back in place
  after a drag; the **sliders** choose what to show (Areas, Lists, Quests). The corner counts projects, lists, quests,
  links and locks.
- Big workspaces stay quick: the canvas draws at most 12 quests of a list (open ones first) and 400 in all, 24 lists
  of an area and 200 in all, 96 areas and 24 projects; the rest is one "+N more" pill that opens the list (or the
  Overview). With **All**, the first 60 of each kind are cards and the rest stay pills. The counts are always the real
  ones. A change that moves nothing (a task finished, words typed by a teammate) updates the canvas in place.
- **Keyboard**: Tab reaches the welcome column and the toolbars first; the canvas is one tab stop: the arrow keys move
  between its nodes (Home, End: the first and last), Enter opens one, and the picture moves to show it.
- Every choice (picture, view, cards, what to show, Recently worked on folded) is yours alone and follows you to other
  devices (preference `home`). Recently worked on comes from `GET /api/me/recent`.

The old **Vision boards** (free canvases of notes, tasks, links and pictures) are unchanged and keep their data; Home
took their place in the sidebar and on Shift+4, and the workspace switcher's menu opens them.

## The workspace menu

Click the workspace switcher at the top left and choose **Workspace settings, people, look…**. A panel opens under it: the sections on the left, the open section on the
right. Every option has a short label and one line saying what it does. The menu is a modal panel: ↑/↓ (Home/End)
move between sections, Enter or Tab goes into the section, Esc closes it and puts focus back on the switcher.
`?menu=<section>` (and `?menu=<section>/<tab>`, e.g. `?menu=connections/discord`) opens it at a section, so a link can
point there; the old `?show=accountSettings` link opens the Workspace section.

| Section | What is there | Who sees it |
| --- | --- | --- |
| Workspace | Name, a short description and a picture | everyone (admins edit) |
| Guides | The tutorial: progress per part, Pause / Resume (hides its top-bar button on this device) | everyone |
| Features | Milestones, effort points, sprints, task chains, vision board, due dates, time tracking, dependencies | admins |
| Tasks | Effort sizes, priority names, when untouched started tasks snooze, archiving done tasks, list tiles, task pictures | admins |
| Calendar | Working days, first day of the week, timeline zoom | admins |
| Entry types | Moved into each project's Wiki (**Types**); the section keeps old links working with **Open Types in the Wiki** | everyone |
| Files | Every file attached to a task you can see, with search and "Pictures only" | everyone |
| Members | People, roles, invite links, people waiting to join (as the Members page) | admins |
| Public links | Projects readable without an account, with their links | everyone |
| Connections | AI assistants (MCP), Discord, Slack, GitHub, GitLab, BitBucket, Steam, player reports (web and Unity), email sending | admins |
| Look | Dark, light, or match this computer (this device only) | everyone |
| Import | Spreadsheet (CSV), Trello, HacknPlan, copy projects | admins |
| Export | Each project's game data file; where backups are | everyone |
| Plan & billing | Plan, seats, invoices | admins |
| Preferences | Emails to me, API tokens, sign-in (Tailscale) | everyone |
| Archive | Archived projects (Unarchive), archived tasks and the newest 100 deleted tasks (Restore) | everyone (restore where you may edit) |
| Disable workspace | Put the workspace to sleep (owner) | admins |

Changes in Workspace, Features, Tasks and Calendar are collected while you move between those sections: a bar
at the bottom says there are unsaved changes, with **Discard** and **Save changes** (closing the menu keeps them until
you save or discard). Everything else saves as before, on its own button or switch. Sections that also exist as a
page (Members, Preferences, Archive, a project's wiki) have **Open full page**. The menu never scrolls sideways: it
fits the window down to 360 px wide, where the section list shrinks to icons, and only the right side scrolls.

The gear menu in the top bar (**Account menu**) keeps quick links: Workspace settings (opens this menu), Members,
API tokens, Email notifications and My account.

## Find or create (Ctrl+K)

**Ctrl+K** (⌘K on a Mac) opens one box that finds tasks, wiki entries, lore, lists and projects, from anywhere,
also while you are typing in an editor (`/` still goes to the top bar's filter search). Results are grouped, with
their type, list and project beside them; an empty box shows what you opened last on this device.

- ↑/↓ (Home/End, Page Up/Down) move, the mouse highlights too, **Enter** opens the highlighted row, **Esc** closes
  and puts you back where you were. A task id (`LH-127`) goes straight to that task.
- The last row is always **New <type> called "<what you typed>"**: an entry of that type in the current project, or a
  page, or a task in the current list (else the project's first list). It then opens. The type is guessed: a type
  whose name, or a word of one of its templates' names, is in what you typed ("Ashen Keep" → Place when Place has a
  "Keep" template); otherwise the type you made last on this device. **Tab** / Shift+Tab change it.
- Enter never makes anything by itself: the New row is only highlighted when you move to it (↓, End or the mouse),
  even when nothing else matches. It is not offered when you can't add to the project.

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
  From the keyboard, use the toolbar's **Connect to…**. "It waits for it" needs dependencies on (workspace menu >
  Features): while they are off, an admin's first use turns them on for the workspace ("It waits for it (turns on
  dependencies)"); anyone else is told an admin can turn them on in Settings.
- The project's area and list frames and its header follow the project: their names can't be edited on the board, and
  they can't be deleted there (delete the list or area from the project instead).
- A project board made with the older tree layout gets **Arrange as frames** in its menu: one undo step, keeping your
  notes and arrows.

## Game wiki and export

Each project has a **Wiki** (sidebar): lore entries with an entry type (Item, Creature, Recipe…), typed fields,
typed links between entries (drops, sells…) and checks. A column of icons beside the wiki leads to its parts:
**Entries**, **Types**, **Link kinds**, **Graph**, **Places**, **Timeline**, **Storyboard**, **Checks**, and
**Export** at the bottom. An empty project offers a small starter set (Character, Creature, Faction, Place, Item,
Quest, History, Storyline and six links). The RPG extras (recipes, abilities, shops, dungeons, weapon and armour
types…) are added from the Wiki's first page or under Types.

### Types and families

**Types** shows the project's entry types in **families** (Characters, Creatures, Items, Places, Story, Systems,
Production for the starter pack), each one folding, with the kinds of a type under it (Weapon under Item), a small
picture per row and counts. **Find a type** opens the families that hold a match; **+** makes a type (a name and a
family). **Families** renames, recolours, reorders, adds and deletes families; deleting one moves its types to
**No family** and never deletes a type. Projects whose types came before families are offered the starter pack's
families for those types ("Group them"); nothing changes until you press it.

A type's page shows its picture, where it sits (family › the type it is a kind of), its icon, name and key, and
counts. **Change picture** picks one of four painted pictures in the family's colour with the type's icon, or
uploads one (PNG, JPEG, GIF or WebP, 10 MB), or picks one **From Assets**; Assets' **Use as a picture of…** offers
types too (to people who manage the project). The type keeps its own copy: deleting the asset leaves it. Entries without a picture of their own show their type's. **Template**
holds the type's page of blocks, **Starting values** (the type's saved templates) and the fields, inherited ones listed by the
type they come from (see **Templates as pages of blocks** below). **Settings** has the name, icon, family (top-level types only: a kind sits in its type's
family), what it is a kind of, its colour, the key (read-only, used by exports) and Delete. Project settings' old
**Entity types** tab opens the Wiki's Types.

### Templates as pages of blocks

A type's **Template** is a page of blocks: **Text** (a section with a grey writing prompt), **Facts** (the fields),
**Model** (a 3D model from the project's Assets), **Picture** (from Assets, or an upload), **Map** (from Assets, from
Groundwork), **Lines** (barks, one per line), **Steps** (numbered), **Table** (columns you name, rows per entry),
**Links** (to entries of a type) and **Pictures in a row**. Each block has a title, ↑ ↓, half or full width and ×;
**+ Add block** adds one. Changes wait for **Done** (or **Cancel**). **Next to an entry** shows one of the type's
entries beside the blocks (the newest; a labelled example when there is none), laid out as you edit. A kind of
another type follows that type's template until you change it; then it has its own, and **Follow <type> again** drops
it.

Entry pages are laid out by their blocks, half-width ones side by side. The text stays Markdown: a text block is the
entry's `## Title` section (**Edit text** opens the editor as before), so links, names, exports and MCP see the same
text. Text before the first heading and sections no block names are shown too. Lines, steps, tables, links and
pictures are edited in place on the page. Entries made before a type had a template follow the template as it is;
nothing is migrated.

- **Guided start** (a template switch): making a new entry asks its name, then each Text, Lines and Steps block
  (Back, Skip), and opens it with the answers in place. **Try a new <type>** walks the same steps without making
  anything.
- **Bring entries up to date…** lists the type's entries made from an older version of its template; ticked ones get
  the blocks they lack, in the template's order and widths. Nothing written is removed: a block the template dropped
  stays on an entry that holds something in it, and a table keeps a column for every cell.
- The starter pack's Character, Creature, Item, Quest, Place and Faction are made for a co-op survival game: fields
  such as Found in, Job, Spawns in, Notices you at, Tier, Weight, Given by, Biome, Safe at night, and pages such as
  Creature's Facts and Model side by side, then Attacks and Drops tables and Behaviour. Projects that added the pack
  before are offered **Update the starter types** for the types that came from the pack (a type of your own with the
  same key is left alone): the new fields are added, and a type with no template of its own gets the page, with a
  text block for each heading it had. The fields it has stay as they are, shown and exported; nothing is removed.

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

### Writing links

- **Names link by themselves.** In any text of a project (lore, wiki entries, task descriptions), the names of that
  project's wiki entries and pages are links to their wiki pages, when reading and while writing in the lore editor.
  Nothing is written into the text: names are recognised when the text is shown, so a new entry or alias links every
  existing mention at once. Matching is whole words and case-insensitive; the longest name wins; names under 3
  characters, names shared by two entries (a wiki check), code, links, URLs and an entry's own page are left out.
- **Aliases.** "Also called" on an entry page adds other names (at least 3 characters, up to 50 per entry), recognised
  like the title. A name another entry also has is kept but flagged: neither links until one changes.
- **Not a link here.** When reading any text (tasks too), right-click a linked name, or focus it and press Alt+Enter
  or the context-menu key, for **Open**, **Open beside** (in the wiki), **Open in new tab**, **Copy link** and **Not a
  link here**, which stops linking that name in this one text (Undo in the toast; focus goes back to the text). In the
  lore editor, hover a name or put the caret on it and press Alt+Enter for the same choices; Ctrl-click (⌘-click on a
  Mac) opens the entry beside the page in the wiki (the editor stays open with your draft), else in a new tab. The names a text
  doesn't link are listed under it and under its editor ("Not linked here"), with × to link one again. A title line
  never links (it is the card's own name).
- **Explicit links.** `[shown text]($code)` links any task or lore with your own words (lore opens its wiki page);
  a plain `$code` still shows the card's title.
- **What links here** on an entry lists "Mentioned in": the texts that name it.

### Side-by-side panels

- **Links open beside.** On a wiki entry page, a click on another entry of the wiki (a name in the text, a link under
  Links or What links here, a field, **Open** in the graph) opens it in a panel to the right instead of leaving the
  page. A click inside a panel opens the next one to its right and replaces any further right, like a column browser.
  Ctrl/⌘-click and middle-click still open a new tab; outside the wiki, links work as before.
- Each panel has its title, a **⋯** menu (Open in new tab, Copy link, Close the panels to its right), **Open full
  page** (it becomes the main entry, the other panels stay) and **×**. Panels show the text, infobox and links; the
  graph, history and attachments are on the full page.
- Every column is shown whole: when they don't all fit, the main entry and then the oldest panels fold to a narrow
  strip with their title (click it, or a link to that entry, to go back to it, which closes the panels after it). At
  most three panels show at full size. The main entry stays full while it fits (one panel at 1600 px, two at 1920 px).
- Text being edited in a panel is kept when the panel is replaced, folded, closed or opened full page: the entry's
  editor opens again with it (a folded strip shows a dot). It is dropped when saved or cancelled, and lives only in
  this tab.
- The panels are in the address (`?panels=key,key`, oldest first), so a reload or a shared link brings them back.
  Each opened panel is a history step: Back closes it, Forward opens it again. **Esc** closes the rightmost panel
  (after any open menu, editor or dialog has had its Esc). Focus goes to a new panel's title; Tab reaches its ⋯, Open
  full page and ×.

### The graph

- **Beside an entry.** Every entry page has a **Graph** tile (under the infobox): the entry in the middle and what it
  is connected to, one or two steps away (**1 step** / **2 steps**, remembered on this device). Connections are typed
  links, entry fields that point at another entry, `$code` references and recognised names, from wiki entries and
  pages of the same project (tasks are not in the graph). Nodes are sized by how many connections they have and
  coloured by entry type (the type's own colour, else one of the theme's graph colours; pages are grey); the
  best-connected show their names. Hover or focus a node to light its connections; click it for a small preview
  under the picture (title, type, first line, how it connects) with **Open**; click the background to clear it. At most 60 nodes: past that, the best-connected
  neighbours are kept and the tile says how many there are.
- **The whole campaign.** **Graph** under "See the world as" on the Wiki's first page (or **Whole graph** on the tile)
  shows every entry of the project (up to 2,000, the best-connected first). Tick types on and off. Over 50 entries,
  each type becomes one circle with its count; click one to open it, **Group by type again** closes them. Wheel to
  zoom, drag to move, **Fit** (or `0`) to see everything again.
- **Keyboard.** The graph is one tab stop. Arrow keys move to the connected entry in that direction, Home to the
  centre, Space previews, Enter opens (or opens a type's circle), Esc closes the preview and then leaves the graph;
  in the campaign graph the view follows the focused entry, `+` / `-` zoom on it, `0` fits and Shift+arrows move the
  view.
- The layout is computed here, without a library, and is the same every time for the same entries and connections
  (fixed steps, no randomness), so the picture doesn't jump around when you come back; it is only redone when the
  connections change, not when a text is edited.

The game gets the data as JSON:

- The Wiki opens on one tile per entity type (entry type). A entity type's page shows what was made from it and starts
  a new one from **Empty**, a **template** (saved starting values and links) or a copy of an existing entry. The
  new-entry page has the values as buttons and sliders, the links as pickers, and a preview.
- A new page starts with a heading per text block of its type's template (a type with no template yet: its page
  headings), so there is something to fill in.
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
changes. Each entry's `blocks` lists its typed blocks that hold something (tables, lines, steps, links by key,
assets); text blocks are the sections of `text`. Task links ("works on") are not part of the game data. The format is documented with the Unity sample in
[`integrations/unity/QuestlogData`](integrations/unity/QuestlogData/README.md), whose editor menu
**Questlog → Pull game data** downloads the file into `Assets/QuestlogData/`. Changing an entry's key by hand (API only) does not rewrite references to the old key: they show up as `broken_ref` checks.

### Balance: tables, rules and the simulator

The wiki can also hold a game's numbers and rules, and run them. Three field kinds do this (add them to an entity
type under **Entity types**, like any other field):

- **Table**: numbers looked up by one or two keys, entered as a grid. A key's values are words (an enum's options,
  matched exactly) or numbers going up. Mode **exact** needs an exact key; **step** takes the largest key at or below
  the number; **linear** goes between the two keys around it.
- **Rule**: a formula with named parts, such as the damage of one hit.
- **Scenario**: a fight (or anything that runs over time) for the **simulator**.

A table or rule is named after its entry's key (`kind_vs_material`, `flat`). When a type has two fields of that kind,
each is named `entry.field`.

**Writing a rule.** A rule has:

- **roles**: names for the entries it reads, with their type, e.g. `attacker` is a Weapon and `target` is a Creature;
- **parts**: named steps, each of which can use the parts above it;
- a **result**.

For example:

```
crit   = chance(attacker.crit_chance)
base   = 15 * if(crit, 2, 1) + flat(attacker)
result = base * table(kind_vs_material, attacker.kind, target.material)
```

The editor helps in three ways:

- **Suggestions** appear as you type: roles, a role's fields with their unit (`armor (hp)`), parts, tables, rules,
  functions, and an enum's options inside quotes. Use ↑/↓ to move, Enter or Tab to take one, Esc to close, and
  Ctrl+Space to open the list.
- **Problems** are underlined and spelled out under the formula, for example "'Creature' has no field 'armr' — did you
  mean 'armor'?" or "can't add a word to a number".
- **Live example**: pick an entry for each role and a seed. Each part's value and the result update as you type.
  **Save as example** keeps that pick. The export runs each saved example into a *golden sample* (every part's value
  and the result), so the game's code can be checked against the wiki.

The rule saves when you leave a box. Its checks also show in the Wiki's checks badge, including when a field it reads
is renamed or deleted.

**The language**:

- numbers, `+ - * / ^` (`2^3^2` is 512, `-2^2` is −4);
- comparisons `== != < <= > >=`, and `and`, `or`, `not`, `true`, `false`;
- enum values in single quotes (`target.material == 'Wet'`);
- `role.field`, part names, and in scenarios state names and `time`;
- other rules, called as `ruleKey(role, …)` (a rule can't call itself, in a loop or otherwise).

| Function | What it gives |
| --- | --- |
| `if(condition, then, else)` | `then` when the condition holds, `else` otherwise |
| `min(a, b, …)`, `max(a, b, …)` | the smallest or largest number |
| `clamp(x, low, high)` | `x` kept between `low` and `high` |
| `round(x[, digits])`, `floor(x)`, `ceil(x)`, `abs(x)` | rounding (halves up) and the value without its sign |
| `rand()` | a random number from 0 up to, but not including, 1 |
| `randint(a, b)` | a random whole number from `a` to `b`, both included |
| `chance(p)` | true with probability `p` (0 to 1) |
| `roll(role.range)` | any number in a range field, `[min, max)`; use `round(roll(…))` for whole numbers |
| `pick(table)` | one of a one-key table's keys, weighted by its numbers |
| `table(table, key[, key2])` | the number in a table for the keys |

Limits:

- a formula is at most 4,000 characters and 64 levels deep;
- a chain is at most 64 terms (split a longer one with brackets or a part);
- rules call each other at most 16 deep.

Randomness is seeded: the same entries and seed always give the same numbers. The export's `random` block documents
the generator so another program can reproduce a run.

**Scenarios.** A scenario has:

- **roles**;
- **state**, each with a start value (`hp` starts at `target.hp`, `hits` at `0`);
- **clocks**;
- an **end** condition;
- a **time cap** in seconds;
- **measures**: numbers read at the end of each run, such as `hits` or `time`.

A clock first fires at once, or after its **first** delay. It then fires every so many seconds; `every` is a formula
and is worked out again after each tick. On each tick the clock sets state in order, for example `hp` to `hp - dmg`,
and then the end condition is checked. Clocks due at the same moment fire in the order they are listed. Times are kept
to the microsecond. `time` is the seconds since the start.

**The simulator** is the scenario's **Simulator** tab. It runs the saved scenario once its checks pass:

1. Pick an entry for each role, a number of runs (10,000 by default, up to 100,000) and a seed.
2. Press **Run**.

The runs happen off the page, in a worker. They show progress, can be cancelled, and stop after 10 seconds. A run
that stopped the batch with a problem is named with its seed.

For each measure the results show:

- a histogram;
- p1, p5, p50 (the median), p95 and p99;
- the mean, min and max;
- for small whole numbers such as hits, the share of each value.

**Outliers** are runs below p1 or above p99, listed with their seeds. **Replay** shows one run tick by tick: the time,
the clock, and the state after each tick. Any seed can be replayed.

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

Workspace menu › Connections › GitHub, › GitLab and › BitBucket (admins). "Generate webhook URL" makes a URL (and, for GitHub and
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

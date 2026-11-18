# Changelog

What changed in each Questlog release. The release workflow publishes the section for a tag as that release's notes,
so add a section here before tagging. When releasing, rename `[Unreleased]` to the version and date; the release job fails if the section is missing.

## [Unreleased]

## [0.3.0] - 2026-11-18

Not tested on Windows yet: the desktop app (including the new Workspace switch) has only been run on Linux for this release. Reports welcome.

The desktop app can now send a crash report to the team. Nothing is sent unless you choose Send.

### Team server
- New team members API for other Jatify tools on the tailnet (the Jatify Launcher's Server tab): `GET /team/members`, `GET /team/requests`, add, change role, remove (disable), approve and deny. It identifies the caller by Tailscale, as `/team/whoami` does. Writes need `X-Jatify: 1` and JSON and refuse any `Origin`. Ownership never moves through it, and only the owner makes or unmakes admins there. See README "Team members API".
- `JATIFY_ADMIN_TOKEN`: when set, a request from this machine (loopback) with a matching `X-Jatify-Token` acts as the owner on that API.
- With `JATIFY_ADMIN_TOKEN` set, the first setup needs that token (`X-Jatify-Token`) from anyone, on this machine or over the network; without it the answer is 403 `setup_token`. Everywhere else the token stays loopback-only.
- Setup links the new owner to their Tailscale login when it is proven (Tailscale sign-in on, or `tailscaleLogin` from this machine with the token) and writes the team file.
- `/team/whoami` includes `teamServer` when `JATIFY_TEAM_SERVER` is set.
- A `Dockerfile` for the server: Node slim image, unprivileged user, data in the `/data` volume, health check on `/healthz`. The image sets `JT_LOOPBACK_TRUST=0`: there the admin token never acts as the owner on the members API (in a container, loopback can be a forwarded remote caller). See README "Run a Questlog server with Docker".

### Desktop app
- The window title says where you are working (Team server (host) or This computer), and a new Workspace menu switches between the team server and this computer, or opens the server chooser. The choice is saved (a typed server is remembered) and the window restarts into it.
- After a crash or unexpected end (the app crashing, the local server stopping on its own, even if you then close the window, or a kill), the next start asks "Questlog closed unexpectedly. Send the report to the team?" with Send, Don't send and See what is sent. Only offered when the Jatify launcher passes a team server (JATIFY_TEAM). Closing the window at the question counts as Don't send.
- The report is a zip of the logs plus report.json (tool, version, OS, and the memory limit if the launcher passes JATIFY_MEMORY_MAX), at most 20 MB. It goes to the team's library service on port 8781, and only to a private or Tailscale address.
- The app now keeps logs/desktop.log beside logs/server.log, both rotated at 5 MB.

### Project boards
- A project board now shows the project as frames: areas side by side, lists stacked inside, open tasks in each list in "waits for" order (rows of 6), subtasks after their parent. Only "waits for" (dashed accent) and "subtask" arrows are drawn.
- It follows the project while open: new tasks, lists and areas appear, done, archived and deleted tasks leave, a task moved to another list moves frames, renames update. Positions you dragged are kept, and undo never undoes what the board did by itself. A board shows only the project of the task it belongs to.
- Zoom out for the overview: each list shows its name and "N tasks left", with thick arrows counting the "waits for" links between lists.
- Drop a task card into another list frame to move the task, or a list onto another area to move the list. A refused move goes back with a message; undo moves it back.
- Hover or select a task to draw arrows from its handles (waits for, subtask or just a line); the toolbar's "Connect to…" does the same from the keyboard.
- An older project board (made with the tree layout) has "Arrange as frames" in its menu: one undo step, your notes and arrows kept.
- Dragging a group (picked with the selection box) into a frame now puts it inside that frame, on any board.
- Arrow labels are drawn above the cards, so a "waits for" between two lists is never hidden.
- "It waits for it" needs dependencies on. When they are off, an admin sees "It waits for it (turns on dependencies)", which turns them on for the workspace; anyone else is told an admin can turn them on in Settings.
- A line you only label "waits for" yourself stays your line: the board never removes it. Undoing the delete of a "waits for" or subtask arrow brings the dependency back too.
- The project's frames and header can't be renamed or deleted on the board (they follow the project); delete the list or area from the project instead.
- Not connected: a task dropped into another list goes back, with a message, instead of moving later on old data. A refresh that fails while connected is retried (1 s, 2 s, 4 s … up to 30 s).

### Lore
- Lore (wiki entries and lore pages) is now written in a live-preview editor: headings, bold, italic, code, bullets, checklists (tick them in place), quotes, task codes, @mentions, #tags and your own images show formatted. The Markdown marks are hidden until you need them: a heading's or the title's marks show while the caret is anywhere on that line, other marks while the caret touches them. Lore keeps your exact Markdown: only your own typing, the formatting bar, shortcuts and ticking a checkbox change the text, and opening and saving without edits stores it byte for byte.
- A formatting bar (Heading, Bold, Italic, List, Checklist, Quote, Link), shortcuts (Ctrl+B, Ctrl+I, Ctrl+Alt+1/2/3), the / menu and the reference pickers, Ctrl+Enter to save, Esc to cancel and focus mode. Tasks keep the plain editor, and so does lore if the lore editor can't load.
- Numbered lists show their raw numbers, and Enter in the middle of a numbered list adds a plain line without renumbering.

### Also
- The server logs fatal errors with their stack before it exits.
- The MCP server reports its real package version (it said 0.1.0).

## [0.2.0] - 2026-11-17

Questlog can now be shared by a team over Tailscale, and the desktop app can open that team's workspace instead of its own. Offline stays the default.

### Team server
- Sign-in by Tailscale (off unless JT_TAILSCALE_AUTH=1): people on the team open Questlog and are signed in, with no password.
- Someone Tailscale knows but the team doesn't sees "ask the owner to add you" and appears under Members > Waiting to join, where an owner or admin adds them with a role or dismisses them.
- Members link their existing account to their Tailscale login from My account (asks for the password). Owners and admins can unlink people, never set a login for them.
- GET /team/whoami tells any tool who it is connected as.
- JT_TEAM_FILE: Questlog keeps a shared team list (team.json) for other team services, and takes in an existing list on first start.

### Desktop app
- Opens a team server when started with JATIFY_TEAM (set by the Jatify launcher), or when you choose "On a server" on first start.
- "Questlog can't reach the server" offers Retry, Change server, or Use this computer. The local workspace is separate; nothing syncs between the two.
- Existing installs keep opening their local workspace.

### Also
- The web app's bundled libraries now ship with their licence texts.
- The release workflow uploads only the archives and checksums.

### Known issues
- The Windows build has not yet been run on a real Windows machine; its layout and executables were checked on Linux. The exe is not signed, so SmartScreen may ask you to choose More info > Run anyway. It needs the WebView2 runtime.
- When the team server drops mid-session, the app shows its own connection state rather than the "can't reach" page.
- Task ids such as LH-127 are display-only. The whole-project board gets hard to read at around 65 tasks. Lore is edited as plain Markdown.

## [0.1.0] - 2026-11-16

First release of Questlog as a private, offline desktop app for planning a game: projects, areas, lists and tasks; a game-data wiki with typed entries, a starter set, storylines you can open as a flow and play; boards; JSON export.

Downloads: Questlog-v0.1.0-linux-x64.tar.gz and Questlog-v0.1.0-win-x64.zip, each with a .sha256. Unpack anywhere and run Questlog (Questlog.exe on Windows). Data stays on your machine: ~/.local/share/questlog on Linux, %LOCALAPPDATA%\Questlog on Windows.

### Known issues
- The Windows build is untested on a real Windows machine. Its layout and executables were checked on Linux; the first real Windows run is still to come. The exe is not signed, so SmartScreen may ask you to choose More info > Run anyway. It needs the WebView2 runtime (present on most Windows 10 and 11 machines).
- Task ids such as LH-127 are display-only; links and $codes keep the short code.
- The whole-project board gets hard to read at around 65 tasks.
- Lore is edited as plain Markdown.

# Changelog

What changed in each Questlog release. The release workflow publishes the section for a tag as that release's notes,
so add a section here before tagging. When releasing, rename `[Unreleased]` to the version and date; the release job fails if the section is missing.

## [0.5.0] - 2026-11-27

### Assistants can arrange vision boards
- Two new MCP tools: `get_vision_board` reads a task's board (its tasks, notes and frames with their places, and its lines), and `edit_vision_board` adds, moves and removes tasks on it and draws or removes lines, all at once or not at all. Anyone with the board open sees the change straight away. It acts as the token's owner: a write token, and only on boards they may edit.

### Translation: Lore fields and fixes
- Lore entries' text fields (such as a character's Description), list and step lines, and table cells are now translated too. Numbers and short amounts like "3.5 kg" stay as written. While you edit, the translation shows under the field.
- Changing the glossary while older text was still being translated could leave some text in the old wording. It is now redone.
- Text that fails to translate three times is tried again a day later, and again whenever the server restarts (for example after a new language pack is installed). Until then it shows as written.

### Read and write in your own language (English ↔ Italian)
- Everyone writes in the language they like and reads in theirs. Pick **English**, **Italiano** or **As written** (workspace menu › Preferences › Sign-in › Reading language); the first time, Questlog asks. Task text, comments, Lore pages and their fields show in your language, with "Translated from Italian · Show original" under them. Titles in lists, tabs, pickers and search follow too, and search finds both languages.
- You always edit the original; while you edit, the translation shows beside it. Copying, exporting and the API keep the original.
- Translation runs on your own server with a small offline model: nothing leaves it. It is off until an owner or admin installs the language pack (below) and switches **Translation** on (workspace menu › Features). It uses about 400 MB of memory while it works and lets it go after 5 idle minutes.
- Each project has a **glossary** (Project settings › Edit glossary): words kept as written, or always translated your way (for example "Storia → Story"). Names of Lore characters, places and items are never translated. Changing the glossary or a name redoes the project's translations in the background.

### Translation: the language pack
- The language pack for English ↔ Italian translation is a separate download, `questlog-translate-models-vX.Y.Z.tar.gz` (about 55 MB, one file for every platform, with a `.sha256`). Unpack it beside the server's `server/` folder, or fill a volume mounted at `/app/models` with Docker, then switch Translation on. The README has the exact lines. The normal server archives and the Docker image stay model-free.
- Engine and models (Bergamot WebAssembly engine, Firefox Translations en-it and it-en) are licensed under the Mozilla Public License 2.0; see NOTICE.md.
- New: `scripts/package-translate-pack.sh <vX.Y.Z> <outDir>` builds the pack; every download is pinned by sha256.

### Smart Nodes: a short guide on your first one
- The first time you add a Smart Node, a small guide opens beside it with the steps: **Pick a project** (on Home only), **Add a filter**, **Choose how it shows**, and **Open it as a search**. Each step is ticked when you do it. **Next ›** moves on without doing it, and **Skip** or Esc closes the guide. When every step is done, it says **Done** and closes.
- It opens on its own once per person, on any device, and only for people who can edit the board. It doesn't open on its own while the Tutorial is paused. **Show guide** in a Smart Node's toolbar shows it again.
- The guide stays beside its node when you drag the node, pan or zoom, and keeps clear of the filter panel and the toolbars. Only you see it. Nothing is saved to the board.

### Home: images and Smart Nodes, each kept with a project
- Home's **Add** toolbar now has **Image** and **Smart Node** too. Each one belongs to a project: Questlog asks **Which project?** first, and skips the question when only one project can be picked. Only projects every member sees and that are not archived can be picked, because everyone in the workspace sees Home. When there is no such project, a message says so.
- An image on Home is uploaded for that project, not attached to a task. A Smart Node on Home counts only that project's tasks. Everyone who sees Home sees both, live. Observers see them but can't add any.
- Deleting a project also deletes its images and Smart Node filters on Home, and removes the image files from disk.
- New: `POST /api/home/files?projectId=…` (images only), and `visionBoard/createQuery` takes a `projectId` instead of a `cardId` for Home. Migration 040 lets uploaded files and Smart Node filters belong to a project instead of a task. Existing rows are copied unchanged.

### Fixes
- With a task open, the list and its panel use the whole width of the window.

## [0.4.0] - 2026-11-19

### Redesign: Home is a real board, shared by the team
- **Home** is a board on the same canvas as the vision boards, one per workspace, shared and live: projects, areas, lists and quests are nodes on it, each moved on its own by dragging (or Shift+arrows), and a move, a note or a frame shows up for everyone at once. The lines are the links Questlog already has: a project has areas, an area has lists, a list has quests, and dashed "this locks that" lines.
- The work keeps itself in step: a new list appears near its area, an archived one leaves, a list or quest moved to another project keeps its place. Done quests leave the board. Nodes of a project someone can't see are never shown to them, and the shared board holds no names or ids of the work, only opaque keys.
- **Add** (left): text notes, scenes, pages and frames on Home, as on any board, with undo. **Boards** (top): Home first, then every vision board you may see, each opening on the same canvas with its scenes, arrows, **Play**, **Variables**, **Cast** and its task; **+** makes a new board. The separate Vision board page is gone; `/vision` links open the board on Home.
- **View, Cards and picture** (right, per person): **Web** or **Tree View** (project → areas → lists → quests), which kinds show as cards (a pill opens into a scene card in place; the pills around it step aside on your screen only), what to show (areas, lists, quests) and the background, four gradients for now.
- **Welcome back** and **Recently worked on** (the tasks and wiki pages you changed or commented on lately, newest first); it folds into a clock button in the top left corner.
- **Split view**: a click on a node or a recent row opens that page beside Home, in the same tab. Links in it stay in it; Back, Forward and reload keep it; **Open in its own tab** and Close in its header; the divider is dragged or moved with the arrow keys, and its width is kept per person. Ctrl/⌘-click or a middle click still opens a tab. On narrow windows the page covers Home, with **Back to Home**.
- Owners, admins and members edit Home; observers look; guests never see it. While its live connection can't be made, Home shows the work read only. On large workspaces the board is capped and its document stays small (a 700-node board is 143 KB).
- New: `GET /api/me/recent`, indexes on task history and comments by person (migration 038), and the Home board itself (migration 039: vision boards get a kind; existing boards and their documents are kept byte for byte).

### Desktop: no password on This computer
- The desktop app signs its owner in to its own local server by itself: each start makes a fresh secret that only the app and its server know, so nothing else on the machine or the network can use it. Team servers still ask as before.

### Wiki: templates as pages of blocks
- A type's **Template** (Wiki › Types) is a page of blocks: Text (with a grey writing prompt), Facts (the fields), Model, Picture, Map, Lines (barks), Steps, Table (columns you name), Links (to entries of a type) and Pictures in a row. Each block has a title, ↑ ↓, half or full width and ×; **+ Add block**; changes wait for **Done**. **Next to an entry** shows one of the type's entries beside it (a labelled example when there is none), following every edit. The named templates are kept as **Starting values** under it.
- A kind of another type follows that type's template until it is changed; then it has its own copy, and **Follow <type> again** drops it.
- Entry pages are laid out by their blocks, half-width ones side by side. The text stays Markdown: a text block is the entry's `## Title` section and **Edit text** opens the same editor; an empty one shows its prompt in grey. Lines, steps, tables, links (to entries) and models, pictures and maps (from the project's Assets, or a picture upload) are edited in place. Text before the first heading and sections no block names are still shown. Existing entries follow their type's template as it is; nothing is migrated, and no text or value changes.
- **Guided start**: with it on, a new entry (from the palette, the Wiki's New entry, a type's page or table) asks the name, then each Text, Lines and Steps block (Back, Skip), and opens with the answers in place. **Try a new <type>** walks the steps without making anything.
- **Bring entries up to date…** lists the entries made from an older version of the template (or from another type's, after **Follow <type> again**) and gives the ticked ones its blocks, order and widths. Nothing written is removed: a table's cells follow their column by name, and a column the template dropped stays while it holds something. An entry given another type takes that type's template the same way. An entry whose page has no Facts block still shows its values in one.
- Two people editing the same block: the second save is refused, the page shows the first one's, and the editor keeps the second one's text to save again. History lists each block change. A deleted asset or a trashed entry in a block is dropped from it at the next save; an asset used in a block is listed under **Used in**.
- The starter pack's Character, Creature, Item, Quest, Place and Faction now have fields and pages for a co-op survival game (Found in, Spawns in, Notices you at, Tier, Biome…; Creature: Facts and Model, Attacks and Drops tables, Behaviour). This applies to projects that add the pack from now on; projects that already have it are offered **Update the starter types**, which adds the new fields to the types that came from the pack (a type of your own with the same key is left alone) and gives one with no template of its own the page, keeping its headings as text blocks. The fields it has stay as they are, shown and exported; no field, value or text is removed.
- The game-data export adds `blocks` to each entry: its typed blocks that hold something (`items`, `columns` and `rows`, `entries` by key, `asset` or `assets`). Nothing else in the file changed.
- New commands `wiki/setPage`, `wiki/setBlock`, `wiki/bringUpToDate` and `wiki/updateStarterTypes`; `wiki/createEntry` takes a guided start's `answers`. The database gets two columns (a type's page, an entry's own layout), both empty for existing data.

### Wiki: Types and families
- The Wiki has its own column of parts beside every wiki page: Entries, Types, Link kinds, Graph, Places, Timeline, Storyboard (with a storyline type) and Checks (a dot while checks fail), and Export game data at the bottom. The header's **Entity types** and **Export JSON** buttons moved there.
- **Types** is a page of the Wiki: the project's types in families that fold (each with its colour and count), kinds under their type, a small picture per row, **Find a type** (opens the families that hold a match) and **+** to make a type with a name and a family. Project settings' **Entity types** tab and the workspace menu's **Entry types** now lead there.
- **Families** are real: a name, a colour and an order per project, edited under **Families** (rename, recolour, move up or down, add, delete). Deleting a family moves its types to **No family**; no type is ever deleted. A kind of another type sits in that type's family.
- The starter pack files the types it adds into its families (Characters, Creatures, Items, Places, Story, Systems, Production). Types a project already had are left alone: a project with starter-pack types and no families is offered "Group them", which changes nothing else.
- Each type has a picture: one of four painted pictures (dusk, dawn, night, flat) in its family's colour with its icon, an uploaded one (PNG, JPEG, GIF or WebP, 10 MB), or one picked **From Assets** (the type gets its own copy; deleting the asset leaves it). In Assets, **Use as a picture of…** also lists the project's types for people who manage it. Entries without a picture of their own show their type's picture on tiles.
- A type's page: picture with **Change picture**, path (family › the type it is a kind of), icon, name, key and counts; **Template** holds the type's template (a page of blocks, below), the named templates as **Starting values**, and the fields, with the inherited ones listed by the type they come from; **Settings** has the name, icon, family, what it is a kind of, colour, the read-only key and Delete.
- The game-data export adds `family` and `picture` to each type and a `families` list after `types` (name, colour, root type keys). Nothing else in the file changed.
- New commands `wiki/createFamily`, `wiki/updateFamily`, `wiki/moveFamily`, `wiki/deleteFamily` (needs **May delete** on a personal token) and `wiki/addStarterFamilies`; `wiki/createType` and `wiki/updateType` take `familyId` and `picture`. The database gets a families table and two type columns; existing types keep everything and start in No family.

### Redesign: the sidebar, tabs and the workspace switcher
- **Sidebar.** A find box at the top filters the sidebar as you type and keeps the parents of what matches (Enter takes the words to Ctrl+K). Then the main pages (Home, My tasks, Inbox with its count, Overview, Milestones, Wiki, Assets, Activity), as a list or an icon row; saved filters; and one folding tree per project: areas, lists with their ring and open count, and the project's **Wiki** with its entries grouped by type. At the bottom: **New task**, **New list**, **New wiki entry**, **New milestone** (each says where the new thing goes: the open list, area or project, or the row you clicked last) and **Collapse**.
- **Folded**, the sidebar is a rail of icons instead of two-letter names: open and find, the main pages, one tile per project that opens its lists beside the rail, and the quick actions. Every icon names itself on hover.
- **Tabs** in the top bar, right beside the workspace switcher. Each tab is one page with its own back and forward. ↗ on a sidebar row, a middle click or Ctrl/⌘-click opens a page in a new tab; double-click pins; at most 12 (the oldest unpinned one closes, with a note). **Home** is pinned first and stays home. **+** opens a New tab page with places to start and recent pages. Back and Forward buttons beside the tabs. Each window keeps its own tabs; a new window starts from the ones you had last. Keys: Alt+1…9 (not while typing, not on a Mac); in the desktop app also Ctrl+T, Ctrl+W and Ctrl+Tab; on a focused tab ←/→, Delete and Shift+P (pin).
- **Workspace switcher** at the top left, in place of the workspace name and the This computer / Team badge: the name, where it is kept, and a menu with this workspace and **Workspace settings, people, look…**. Switching to another workspace stays with the desktop app's strip.
- New pages: **Home** (see above) and **New tab**. **Assets** is a main page of the sidebar.
- The sidebar (folded or not, main pages as a list or icons), its folds and the tabs are kept per person on the server (new table `user_prefs`, `GET /api/prefs`, `PUT /api/prefs/<key>`), so they follow you to other devices. Only while the server cannot be reached are they kept in the browser.
- Fixed: the board's columns were near-black in the light look.

### Assets
- An **Assets** page per project (`/assets`, a main page in the sidebar): pictures, 3D models, maps and concepts, each a copy Questlog keeps with a link back to where it came from. Find by name, pick a kind (All, Pictures, 3D models, Maps, Concepts; Sounds later), toggle what it is for (Characters, Creatures, Items, Places, Interface, Key art), and browse a gallery grouped by source (From Asset Shelf, Maps from Groundwork, Uploaded), each picture at its own height with its name and kind on hover and a **3D** badge on models.
- **Add**: from your computer (PNG, JPEG or WebP pictures, and single-file `.glb` models under the file size limit; a model gets a picture rendered from it for the gallery), from a URL (the server downloads it and keeps its own copy: public addresses only, checked at every redirect, at most three redirects, the file size limit, pictures and `.glb` only, and the file's first bytes must match), from **Asset Shelf** (browse packs and their assets; **Add to Questlog** copies the asset's picture and a link to its pack and path, never the model) and from **Groundwork** (maps and props; their picture and a link). A browser add-on for pictures on the web is coming; the menu says so.
- The Asset Shelf and Groundwork browsers read the team's library service (version 0.7.0 or later): in the desktop app's **This computer** through the local server (from your computer, signed in, only to a private or Tailscale address, read routes only), on a team server straight from the page. Without a team server they say "needs a team server"; with an older or missing library service, "not available on this server yet". Adding from your computer and from a URL always works.
- Opening an asset shows the big picture, or for a `.glb` an orbit viewer (drag to turn, scroll to zoom, Lit, Clay, Wireframe, turntable; it loads only when a model is opened and frees everything when closed). Beside it: the source and link back, what Questlog keeps, where it is used, its name, kind and what it is for (editable), **Use as a picture of…** (gives a wiki entry its own copy of the picture, among its pictures) and **Delete** (removes Questlog's copy only; entries keep theirs).
- Asset copies live in the files folder (`assets/`), count toward a plan's storage, are removed with their project and by the workspace deletion, and are kept by the startup clean-up. Rename, retag and delete are commands (`assets/update`, `assets/delete`; deleting through a personal token needs **May delete**). MCP has `list_assets`.

### Suggestion button
- A **Suggestion** button in the top bar, for people on the team: words (up to 20,000 characters) and up to ten PNG or JPEG screenshots (10 MB each, 19 MB together), added with **Add screenshots…**, **Paste picture** or Ctrl+V, each with a remove button. Nothing is sent until **Send**; if sending fails the dialog says why and keeps the words.
- It goes to the team's library service (port 8781 of the team host) with your name, Questlog's version and the pictures. It is shown only when the library service knows you as a member of the team (owner, admin, member or observer).
- On a team server (`JATIFY_TEAM_SERVER`), the page sends straight to the library service. In the desktop app's **This computer**, the page hands it to the local server, which sends it on from your computer (only from this computer, signed in, at most 20 MB, only to a private or Tailscale address). The desktop app now passes the team server it knows to its local server as `JATIFY_TEAM`. `GET /api/status` says which in `suggestions`.

### Desktop: the workspace strip
- Stopping Questlog with SIGTERM, SIGINT or SIGHUP (the Launcher's `systemctl stop`, Ctrl+C) now takes the normal shutdown: the local server is stopped, and the next start no longer offers a crash report for it.
- A narrow strip at the left of the window with a button for **This computer**, each known team server (`JATIFY_TEAM`, a server you typed, the one This computer replaced) and **+** for the chooser. The open workspace is highlighted, tooltips give the server's address, a click switches (as the Workspace menu does: the choice is saved and the window restarts).
- Keyboard: **F6** (Workspace › Go to the workspace strip) focuses the strip, ↑, ↓, Home and End move, Enter switches, Esc returns to the page. Buttons have screen-reader labels and the open one is marked current.
- The strip is the desktop app's own view (a second webview with a page the app makes), not part of the server's page: a server's page still cannot switch servers, and the strip's addresses are blocked in the page's view. The desktop build now uses Tauri's `unstable` feature (multiple webviews in one window) and is pinned to Tauri 2.12.x. Nothing can be dropped on the strip, and its page loads nothing but its own style and script.
- The web app shows a badge in the top bar, **This computer** or **Team: <host>**, and the New project dialog says "Goes to: …". The server says which it is in `GET /api/status` (`workspace`): the desktop app sets `JT_WORKSPACE_LABEL` on its own server; any other is a team server, named by `JATIFY_TEAM_SERVER` or the address it was reached at.

### API: "May delete" required for token deletes
- A personal token without **May delete** can no longer delete through the command API (`/dispatch`) either, as with MCP: deleting tasks (`cards/update` / `cards/bulkUpdate` with `visibility: "deleted"`), lists, projects, milestones and their zones, presets, vision boards, time entries, attachments, wiki types, link kinds and links, pruning wiki values, clearing a journey and archiving a run config (which cannot be undone) are refused with `403 token_cannot_delete` and a plain-word message. Existing tokens are affected: create a new one with May delete ticked where a script deletes.
- People signed in to the app and org (integration) tokens are not affected. A token's own rows (saved searches, reactions, watches, bookmarks, Hand) stay open to it.
- The token dialog says that May delete applies to the API and MCP.

### MCP: deleting with a "May delete" token, creating projects
- A personal token can be created with **May delete** (off by default; Read & write tokens only). The token list shows it. Tokens made before it cannot delete.
- New MCP tools for such tokens: `delete_cards` (up to 100 tasks per call, soft delete: restorable from Archive), `delete_deck` (the list is removed for good, its tasks go to Archive; needs `confirm: true`) and `delete_milestone` (removed for good, tasks keep their place; needs `confirm: true`). The owner's own rights still apply, as in the app.
- New MCP tool `create_project` (admin-role write tokens whose owner may create projects).
- `get_context` reports whether the token may delete.

### The workspace menu (replaces Workspace settings)
- Click the workspace name at the top left: a menu opens under it with sections on the left (Workspace, Guides, Features, Tasks, Calendar, Entry types, Files, Members, Public links, Connections, Look, Import, Export, Plan & billing, Preferences, Archive, Disable workspace) and the section on the right. Admin-only sections are hidden from everyone else; `?menu=<section>` opens it at a section.
- Every option of the old Workspace settings dialog moved into a section, with a clearer label and one line saying what it does (e.g. "Archive done tasks — Done tasks move out of lists after this many hours. Nothing is deleted.").
- New: a workspace description and picture; tutorial Pause / Resume; a light look (per device); Files across the workspace; Entry types as a searchable tree with Template and Settings tabs; Export of each project's game data; Archive with archived projects, archived tasks and deleted tasks you can restore.
- Keyboard: ↑/↓ between sections, Enter into a section, Esc closes and returns focus to the workspace name.
- Fixed: Workspace settings scrolled sideways (at 1920×1160 too) and cut selects and rows off at the right edge. The menu fits any window from 360 px wide and only scrolls up and down.
- Settings edits are kept while moving between sections and sent with one Save (only what changed); closing the menu keeps them until saved or discarded.
- The gear menu is now **Account menu** for everyone; its Workspace settings item opens the new menu. Billing returns to `?menu=billing`.
- The workspace name at the top left no longer goes to Overview; it opens the workspace menu. Overview stays in the sidebar and on Shift+2.
- CSV import drops a column that has a header but no values (as intended; it was kept before).
- Two stored settings that nothing uses yet (tutorial level, newcomers' default list) are no longer shown; their values are kept.

### Wiki: side-by-side panels
- In the wiki, following a link to another entry opens it in a panel to the right instead of leaving the page; a link in a panel opens the next one beside it (replacing those further right). Ctrl/⌘-click and middle-click still open a new tab.
- Each panel has ⋯ (Open in new tab, Copy link, close those to its right), **Open full page** and ×. Columns are always shown whole: when space runs short the main entry, then the oldest panels, fold to a strip with their title; at most three panels show in full.
- Unsaved text in an entry's editor survives its panel being replaced, folded, closed or opened full page.
- The panels are kept in the address (`?panels=`): a reload restores them, Back closes the last one opened, Forward reopens it, Esc closes the rightmost.
- A linked name's menu gains Open beside (in the wiki), Open in new tab and Copy link; after Not a link here focus goes back to the text; the menu closes when the window is resized. Ctrl/⌘-click on a name in the lore editor opens it beside the page in the wiki (the draft stays).
- The graph tile's Open opens beside the entry. A graph no longer leaves a pending animation frame behind when it closes.

### Wiki: the graph
- Every entry page has a Graph tile: the entry and what it connects to (links, entry fields, `$code` references and names in the text), one or two steps away. Nodes are sized by connections and coloured by type; click one for a preview with Open; hovering lights its connections. Up to 60 nodes, the best-connected kept.
- A Graph view of the whole project in the Wiki (up to 2,000 entries): filter by type, one circle per type above 50 entries (click to open it), wheel and drag to zoom and move, Fit.
- Keyboard: arrows move between connected entries (the view follows), Space previews, Enter opens, Esc leaves; `+` / `-` zoom on the focused entry, `0` fits, Shift+arrows move the view.

### Find or create with Ctrl+K
- Ctrl+K (⌘K on a Mac) opens a palette that finds tasks, wiki entries, lore, lists and projects, grouped, from anywhere (also while typing in an editor). An empty box shows what you opened last on this device; a task id goes straight to the task.
- Its last row makes a new entry, page or task of that name in the current project or list and opens it. The type is guessed from the words (a type's name or a word of its templates), else the one you made last; Tab changes it. Enter only creates when that row is highlighted.
- Ctrl+K is in the `?` list.

### Wiki: names become links by themselves
- The names and aliases of a project's wiki entries are links in its texts (lore, entries, task descriptions), when reading and while writing. Nothing is written into the text, so a new entry links every old mention at once, also on pages other people have open.
- "Also called" on an entry page edits its aliases; a too-short alias says why.
- **Not a link here** (with Undo) turns off one wrong match in one text: from a linked name's menu when reading (right-click, or Alt+Enter on it), or its popover in the lore editor (hover, or Alt+Enter). Ctrl-click (⌘-click on a Mac) in the editor opens the entry (beside the page in the wiki, else in a new tab). The names a text doesn't link are listed under it and its editor, with × to link one again. Alt+Enter is in the `?` list.
- `[shown text]($code)` links a task or lore with your own words; plain `$code` works as before.
- What links here gains "Mentioned in": the texts that name the entry.

### Balance: tables, rules and a simulator in the wiki
- New field kinds **Table** (a grid of numbers by one or two keys: exact, step or linear), **Rule** (roles, named parts and a result written as formulas) and **Scenario** (state, clocks, an end condition, a time cap and measures). They are checked with the rest of the wiki: a formula that reads a renamed or deleted field shows up as a check.
- The formula editor suggests roles, fields with their unit (`armor (hp)`), parts, tables, rules and functions as you type. It underlines problems and states them in plain words ("'Creature' has no field 'armr' — did you mean 'armor'?"). A live example beside the formulas shows each part's value and the result for the entries and seed you pick, and updates as you type. **Save as example** keeps one.
- A scenario's **Simulator** tab runs up to 100,000 seeded runs in a worker. It shows progress, has Cancel, and stops after 10 s. Each measure gets a histogram, p1/p5/p50/p95/p99, the mean, min and max. Outliers are listed with their seeds, and any run can be replayed tick by tick.
- The export adds `random` (the documented generator), `tables`, `rules` (formula text and expression tree, with golden samples from the saved examples) and `scenarios`. As before, it holds only what passed the checks.
- A table's key lists no longer lose numbers when the mode is changed, or a cell is left, while a key list is half typed.

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

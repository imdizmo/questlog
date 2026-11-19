# Jatify Reporter for Unity

Players send bug reports and feedback from inside your game. Each report becomes a quest in your Questlog
workspace, with an optional screenshot or other files.

> **Status: unverified.** The scripts compile against the Unity 6 engine assemblies (checked with the C# compiler
> outside the editor). They have **not** been imported into a Unity project or run in a game yet. Expect to fix small
> things on the first real try; see "First run checklist" below.

## Requirements

- Unity 2021.3 or newer.
- A Questlog workspace with user reports set up: an admin opens the workspace menu (top left) → **Connections → Player reports from Unity**,
  enters the game's name and picks the questline reports go to.
- Players' machines must reach the tracker's address. It runs on your local network, so reports only arrive from
  machines on that network (or through a reverse proxy you set up). The address must be one the tracker accepts as a
  host: its own LAN address and name are accepted, others need `JT_HOSTS`.

## Install

1. In Unity open **Window → Package Manager**, click **+**, choose **Add package from disk…** and pick
   `integrations/unity/JatifyReporter/package.json` from the tracker's source. (Or copy this folder into your
   project's `Packages/` folder.)
2. Create an empty object in your first scene and add the **Jatify Reporter** component.
3. Fill in:
   - **Server URL**: the tracker's address, for example `http://10.0.0.20:8780`.
   - **Report Token**: a token from the settings page (the "default" one, or one per build or channel).
4. For a ready-made form add **Jatify Report Form** to the same object. **F8** opens and closes it (needs the legacy
   Input Manager, or "Both"; with only the new Input System call `Open()` from your own input code).

The object is kept across scene loads (switch **Keep Across Scenes** off to change that).

## Use from your own UI

```csharp
using System.IO;
using Jatify.Reporter;

var reporter = FindObjectOfType<JatifyReporter>();
reporter.SendReport(
    "Fell through the floor\nNear the second bridge, after a double jump.",
    Severity.High,
    "player@example.com",                        // optional, null for none
    new[] { File.ReadAllBytes(logPath) },        // optional, null for none
    new[] { "player.log" },
    result => Debug.Log(result.Ok ? "Sent " + result.CardId : result.Error));
```

- The first line of the text is the quest's title. At most 10,000 characters.
- `Severity.None`, `Low`, `High` or `Critical`. The workspace can send each severity to its own questline and, if
  "Severity sets priority" is on, critical and high reports get priority A and low ones priority C.
- At most 5 files of 10 MB each.
- The email is optional. When the quest is done the reporter can be told by email (the tracker sends these emails
  from a later version on).
- `SendReport` returns the coroutine; the callback runs on the main thread.

## What it sends

1. `POST <server>/user-report/v1/create-report` with the report token in an `X-Report-Token` header (the
   `?token=<report token>` query parameter also works, but URLs end up in logs more easily) and JSON
   `{"content", "severity"?, "fileNames"?, "userEmail"?}`. The answer is
   `{"ok": true, "cardId", "uploadUrls": [{"fileName", "url", "fields"}]}`.
2. For each file, `PUT <server><url>` with the raw bytes. Each upload URL works once and expires after 15 minutes.

The token's name becomes a tag on the quest (the "default" token tags quests `#default`). A token that is switched off
in the settings gets `403`; more than 30 reports a minute per token get `429 rate_limit`. Each token may also file
500 reports and upload 1 GB of files per UTC day; past either, reports and uploads get `429 report_budget` with a
`Retry-After` until the next UTC midnight.

## Tokens per build

Build scripts can make a token per build with the **access key** (shown once in the settings; Regenerate makes a
new one):

```
POST <server>/user-report/v1/create-report-token
X-Access-Key: <access key>          (or ?accessKey=<access key>)
{"label": "Steam beta 1.4"}
→ {"ok": true, "token": "jtrt_…"}
```

Keep the access key out of the game build itself; only report tokens belong there.

## First run checklist (unverified parts)

- The package imports without errors in your Unity version (written for 2021.3+, compile-checked against Unity 6).
- A report from the editor's play mode arrives as a quest in the chosen questline.
- The screenshot from the form arrives as an attachment (and becomes the quest cover).
- With the new Input System only, F8 does nothing (expected); `Open()` still works.
- Time scale returns to its old value when the form closes.

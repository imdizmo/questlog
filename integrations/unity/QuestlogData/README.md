# Questlog Game Data for Unity

An editor menu, **Questlog → Pull game data**, that downloads a campaign's wiki as JSON into
`Assets/QuestlogData/<campaign>-gamedata.json` and refreshes the asset database. It stops there: turning the JSON into
ScriptableObjects, prefabs or tables is your game's own code.

> **Status: unverified.** The script compiles against the Unity 6 editor assemblies (checked with the C# compiler
> outside the editor, `-warnaserror`). It has **not** been imported into a Unity project or run yet. Expect to fix
> small things on the first real try; see "First run checklist" below.

## Requirements

- Unity 2021.3 or newer (editor only; nothing of this package goes into a build).
- A Questlog API token that can read the campaign, made under **API tokens** (the workspace menu (top left) →
  **Preferences → API tokens**, or the gear's Account menu). Access "Read" is enough. A token
  confined to some campaigns can only pull those.
- The editor's machine must reach the tracker's address (see the tracker's README, "Host names").

## Install

1. In Unity open **Window → Package Manager**, click **+**, choose **Add package from disk…** and pick
   `integrations/unity/QuestlogData/package.json` from the tracker's source. (Or copy this folder into your
   project's `Packages/` folder.)
2. Open **Questlog → Pull game data** and fill in:
   - **Server URL**: the tracker's address, for example `http://10.0.0.20:8780`.
   - **Campaign id**: in the tracker's Wiki, copy the address of the **Export JSON** button; the id is the part
     between `/api/wiki/` and `/export`.
   - **API token**: the read token.
   - **Include plain pages**: also export untyped lore pages (off by default).
   - **Strict**: refuse the download while the wiki has failing checks.
3. Click **Pull game data**.

**Token safety:** over `http://` the token crosses your network in clear text, and EditorPrefs are plain text in your
user profile. Use a **read** token confined to this campaign, so a leaked token can read one campaign and change
nothing; put the tracker behind HTTPS (a reverse proxy) if the network is not yours. The sample never follows
redirects, so the token is only ever sent to the server URL you entered.

The settings are kept in **EditorPrefs** (per user and machine), never in an asset, so the token is not committed
with your project. The download goes to the project's `Temp/` folder first and is moved into `Assets/` only when it
succeeds; a failed pull leaves the previous file in place.

## What it calls

`GET <server>/api/wiki/<campaign id>/export?includePages=0|1&strict=0|1` with `Authorization: Bearer <token>`.

- `200`: the JSON below, with `Content-Disposition: attachment; filename="<campaign key>-gamedata.json"`.
- `401`: no or bad token. `404`: no such campaign, or the token can't see it.
- `413 too_large`: the campaign has more than 50,000 exported entries or 200,000 links, or more than 128 MB of field
  values, entry text and link properties.
- `422 checks_failed` (strict only): `{"error": "checks_failed", "checks": [...]}`, and no file. Over 1,000 checks it
  lists the first 1,000 and adds `"checksTotal": N, "checksTruncated": true`.
- `423 workspace_disabled`: the workspace is switched off.

## The format (`questlog-gamedata`, version 1)

```json
{
  "format": "questlog-gamedata",
  "version": 1,
  "campaign": { "id": "…", "name": "Ashen Isles" },
  "exportedAt": "2026-11-15T20:00:00.000Z",
  "types": [
    { "key": "item", "name": "Item", "parent": null,
      "fields": [{ "key": "value", "kind": "integer", "required": true, "min": 0, "max": null, "options": null, "target": null }],
      "family": "Items", "picture": "dusk" },
    { "key": "weapon", "name": "Weapon", "parent": "item",
      "fields": [{ "key": "damage", "kind": "number", "required": false, "min": null, "max": null, "options": null, "target": null }],
      "family": "Items", "picture": "file" }
  ],
  "families": [{ "name": "Items", "color": "#b8862f", "types": ["item"] }],
  "linkKinds": [
    { "key": "drops", "label": "drops", "reverseLabel": "dropped by", "from": ["creature"], "to": ["item"],
      "props": [{ "key": "chance", "kind": "number", "required": false, "min": 0, "max": 100, "options": null, "target": null }] }
  ],
  "entries": [
    { "id": "…", "key": "fire_sword", "type": "weapon", "name": "Fire Sword", "aliases": ["Flame Blade"], "parent": null, "tags": [],
      "fields": { "value": 30, "damage": 12 }, "text": "Markdown after the title line",
      "blocks": [{ "title": "Recipe", "kind": "table", "columns": ["Material", "Amount"], "rows": [["Iron", "2"]] }] }
  ],
  "links": [{ "kind": "drops", "from": "wolf", "to": "fire_sword", "props": { "chance": 40 }, "order": 0 }],
  "random": { "generator": "xoshiro128**", "seeding": "…", "mix": "…", "float": "(next() >>> 8) / 2^24", "runSeed": "…", "order": ["…"] },
  "tables": [
    { "name": "kind_vs_material", "entry": "kind_vs_material", "field": "grid", "unit": null,
      "keys": [{ "field": "kind", "values": ["Pierce", "Slash"] }, { "field": "material", "values": ["Wet", "Dry"] }],
      "mode": "exact", "cells": [0.5, 1, 1.2, 0.8] }
  ],
  "rules": [
    { "name": "hit_damage", "entry": "hit_damage", "field": "rule", "language": 1,
      "roles": [{ "name": "attacker", "type": "weapon" }, { "name": "target", "type": "creature" }],
      "parts": [{ "name": "base", "formula": { "text": "attacker.damage * table(kind_vs_material, attacker.kind, target.material)", "tree": { "t": "binary", "…": "…" } } }],
      "result": { "text": "base - target.armor", "tree": { "…": "…" } },
      "samples": [{ "roles": { "attacker": "fire_sword", "target": "slime" }, "seed": 1, "parts": { "base": 6 }, "result": 4 }] }
  ],
  "scenarios": [
    { "name": "duel", "entry": "duel", "field": "scenario", "language": 1, "roles": [{ "name": "attacker", "type": "weapon" }],
      "state": [{ "name": "hp", "start": { "text": "target.hp", "tree": { "…": "…" } } }],
      "clocks": [{ "name": "swing", "every": { "text": "1.2", "tree": { "…": "…" } },
                   "first": { "text": "0.5", "tree": { "…": "…" } },
                   "do": [{ "name": "hp", "formula": { "text": "hp - hit_damage(attacker, target)", "tree": { "…": "…" } } }] }],
      "end": { "text": "hp <= 0", "tree": { "…": "…" } }, "cap": 60,
      "measures": [{ "name": "time_to_kill", "formula": { "text": "time", "tree": { "…": "…" } } }] }
  ],
  "checks": [{ "entry": "wolf", "problem": "sum_exceeded", "detail": "drops.chance adds up to 110, max 100" }]
}
```

- **Keys are the identity to use.** An entry's `key` (and `id`) never change when it is renamed; type, field and link
  kind keys never change at all. Names and labels are for display.
- **Types** list their own fields only, plus `parent` (a type key). A child type has its parent's fields first, then
  its own, several levels deep. A link kind that allows a type also allows its children. `family` is the name of the
  family its root type is filed under (`null`: none), and `picture` is the wiki's picture of the type: a painted style
  (`dusk`, `dawn`, `night`, `flat`) or `file` for an uploaded one. Both are for display only.
- **Families** group root types in the wiki (Characters, Items, ...): `name`, `color` (`#rrggbb`) and the keys of the
  root types filed under it, in the wiki's order. Families have no key; a rename changes `name`.
- **Entries** carry all their values in `fields`, inherited ones included, flattened (except tables, rules and
  scenarios, below). `aliases` are the entry's other names (display text, as typed; `[]` when none). `parent` is the key of the
  entry's parent page in the wiki tree, or `null`. `type` is `null` only for plain pages (with `includePages`).
  `blocks` (added later; read it only when present) lists the entry's typed blocks that hold something, in its page's
  order: `{title, kind}` with `items` (`lines`, `steps`), `columns` and `rows` of strings (`table`), `entries` as keys
  (`links`), `asset` (`model`, `picture`, `map`) or `assets` (`gallery`) as `{id, title}`. Text blocks are the `## `
  sections of `text`; Facts are `fields`. `[]` when none.
- **Values** come in their declared kinds: `text`, `longtext`, `color` (`#rrggbb`) and `enum` as strings; `number`
  and `integer` as numbers; `boolean`; `multienum` as a string array; `range` as `{"min", "max"}`; `entry` as an entry
  key and `entries` as an array of keys; `image` as `{"file": "<attachment name>", "url": "/api/files/<id>"}` (the
  download path needs a browser session of the tracker; tokens can't fetch files).
- **Tables, rules and scenarios** are field kinds (`table`, `rule`, `scenario`, listed in `types` like any field).
  Their values are **not** in `entries[].fields`: each one is in the `tables`, `rules` or `scenarios` list, with
  `entry` and `field` saying where it lives and `name` saying how formulas refer to it.
  - **Names:** the key of the entry that holds it. When the entry's type has two or more fields of that kind, each is
    named `entryKey.fieldKey` instead (so adding a second table field to a type renames its tables). Formulas look a
    table up with `table(name, key[, key2])` or draw from it with `pick(name)`, and call a rule with
    `name(role, …)`. A table or rule whose entry key is a built-in function or word of the language (`min`, `roll`,
    `table`, `and`, …) can't be named and is left out with a check.
  - **Tables:** one or two `keys`; a key's `values` are words (matched exactly) or numbers going up; `field` is a hint
    for people (the field the key usually comes from), not checked. `mode` is `exact`, `step` (largest value at or
    below) or `linear` (between neighbours, clamped). `cells` are row-major: `cells[i0 * keys[1].values.length + i1]`.
  - **Formulas** are `{ "text", "tree" }`: the text as written, and its expression tree in formula language
    `language` (1). Tree nodes: `num`, `word`, `bool`, `name`, `field` (`role.field`), `unary`, `binary`, `call`
    (built-in function or rule), each with `from`/`to` positions in the text.
  - **Rules** run their `parts` in order (each may use the ones before), then `result`. `samples` are golden samples:
    saved examples run by Questlog, with the role entries (keys), the seed, each part's value and the result. Run the
    same rule in your code with the same entries and seed and compare.
  - **Scenarios** have state with start formulas, clocks (`every` seconds, then `do` updates in order), an `end`
    condition, a time `cap` in seconds and `measures`; `time` is the seconds since the run started. A clock's optional
    `first` is the delay before its first tick (absent = it fires at time 0). Clocks due at the same instant fire in
    the order they are listed. `end` is checked once at the start and after every tick. Times are whole microseconds
    (each delay is rounded to 1 µs), so 0.1 + 0.1 + 0.1 ties with 0.3; `random.scenario` spells out the whole order of a
    run.
  - **random** documents the one seeded generator every formula uses (`rand`, `randint`, `chance`, `roll`, `pick`),
    and the order draws happen in, so another program can reproduce a sample or a run exactly.
  - Only sound ones are exported. A table, rule or scenario with a formula error, a call to a missing, broken or
    looping rule, or an unknown role type is left out and listed in `checks` as `formula_error`; an example that fails
    loses only its own sample (also listed).
- **Links** reference entries by key. `order` counts from 0 within one source and kind.
- **What is left out:** values that don't fit their field, image values that are no longer an attachment of the
  entry, references and links to missing, deleted or wrong-type entries (without `includePages`, a plain page counts
  as missing), invalid link properties, and the tracker's quest links ("works on"). Every value or link left out for
  being invalid is listed in `checks`, so **everything present is valid** and can be used without checking again.
  Entries with a check problem are still exported, minus the bad values. The Wiki's checks badge counts the same
  checks as an export without `includePages`.
- **Links to a trashed entry** are left out without a check: they come back when the entry is restored.
- **Left out without a check:** values of hidden fields (hiding a field retires it on purpose), values whose key is not
  a field of the entry's type, and a `parent` that is not in the file (then `null`).
- **checks** problems: `missing_required`, `invalid_value`, `broken_ref`, `wrong_type_ref`, `link_type_not_allowed`,
  `sum_exceeded`, `bad_key`, `duplicate_key`, `formula_error` (a table, rule or scenario left out, or an example not
  run; `detail` names the field, the part and the problem, with its column). `entry` is the entry key (or its id when it has none). At most 1,000
  are listed; when there are more, `checksTotal` (the full count) and `checksTruncated: true` follow `checks`. Both
  keys are absent otherwise.

## First run checklist (unverified parts)

- The package imports without errors in your Unity version (written for 2021.3+, compile-checked against Unity 6).
- **Questlog → Pull game data** opens the window; the settings survive an editor restart.
- A pull with a read token writes `Assets/QuestlogData/<campaign key>-gamedata.json` and it shows in the Project view.
- A wrong token shows "refused (401)"; a strict pull with failing checks shows the checks and leaves the old file.

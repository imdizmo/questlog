#!/usr/bin/env bash
# Builds the launcher-installable Questlog archives:
#   scripts/package-desktop.sh <vX.Y.Z> <outDir> [linux|win|all]   (default: all)
#
# Writes <outDir>/Questlog-vX.Y.Z-linux-x64.tar.gz and/or Questlog-vX.Y.Z-win-x64.zip, each with a .sha256 beside
# it. Each archive has one top folder Questlog/ with Questlog[.exe], icon.png, runtime/node[.exe] (+ Node's
# LICENSE), server/server.mjs, server/migrations/*.sql and web/, plus the notices: LICENSE, NOTICE.md,
# THIRD-PARTY-RUST.txt (crates compiled into the shell) and server/server.mjs.LEGAL.txt (licence comments of the
# npm packages in the server bundle). The shell's version metadata is stamped from <vX.Y.Z>.
# `win` takes a prebuilt Questlog.exe from $QUESTLOG_WIN_EXE. The Node runtime version is scripts/node-version.txt;
# downloads are cached in ~/.cache/gametracker/node-dist/ and checked against nodejs.org's SHASUMS256.txt.
set -euo pipefail

die() { echo "package: $*" >&2; exit 1; }

[[ $# -ge 2 && $# -le 3 ]] || { echo "usage: $0 <vX.Y.Z> <outDir> [linux|win|all]" >&2; exit 2; }
version=$1
out=$2
target=${3:-all}
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like v1.2.3, got '$version'"
case "$target" in linux | win | all) ;; *) die "target must be linux, win or all, got '$target'" ;; esac
want() { [[ "$target" == all || "$target" == "$1" ]]; }
if want win; then
  [[ -n "${QUESTLOG_WIN_EXE:-}" && -f "$QUESTLOG_WIN_EXE" ]] || die "win needs a prebuilt Questlog.exe in \$QUESTLOG_WIN_EXE"
  command -v zip >/dev/null && command -v unzip >/dev/null || die "win needs zip and unzip on PATH"
fi

root=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib/node-dist.sh
source "$root/scripts/lib/node-dist.sh"
# Heavy steps run under a memory cap; CI runners (no user systemd) set QUESTLOG_NO_CAP=1.
cap() {
  if [[ -n "${QUESTLOG_NO_CAP:-}" ]]; then "$@"; else systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 "$@"; fi
}

umask 022
mkdir -p "$out" "$dist_cache" "$HOME/.cache/gametracker/scratch"
out=$(cd "$out" && pwd)
work=$(mktemp -d "$HOME/.cache/gametracker/scratch/package.XXXXXX")
trap 'rm -rf "$work"' EXIT

# --- build -------------------------------------------------------------------------------------------------------
echo "package: building web and server"
(cd "$root" && cap pnpm build)
(cd "$root" && cap node scripts/build-server.mjs "$work/server")
if want linux; then
  echo "package: building the Linux shell"
  (cd "$root/desktop/src-tauri" &&
    CARGO_BUILD_JOBS=4 cap cargo tauri build --no-bundle --config "{\"version\":\"${version#v}\"}")
fi

# --- Node runtime ------------------------------------------------------------------------------------------------
# Writes the crates compiled into the shell for one target triple (normal dependencies reachable from the
# questlog crate, as resolved from Cargo.lock): name, version, licence, source.
rust_notices() {
  local triple=$1 dest=$2
  (cd "$root/desktop/src-tauri" && cargo metadata --format-version 1 --locked --filter-platform "$triple") |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const m = JSON.parse(s);
        const pkgs = new Map(m.packages.map((p) => [p.id, p]));
        const nodes = new Map(m.resolve.nodes.map((n) => [n.id, n]));
        const seen = new Set();
        const todo = [m.resolve.root];
        while (todo.length) {
          const n = nodes.get(todo.pop());
          for (const d of n.deps) {
            if (seen.has(d.pkg) || !d.dep_kinds.some((k) => k.kind === null)) continue;
            seen.add(d.pkg);
            todo.push(d.pkg);
          }
        }
        const rows = [...seen].map((id) => pkgs.get(id))
          .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
          .map((p) => `${p.name} ${p.version}\t${p.license ?? "see " + (p.license_file ?? "the crate")}\t${p.repository ?? ""}`);
        console.log(`Rust crates compiled into the Questlog executable (${process.argv[1]}), with their licences.\n` +
          "The full licence text of each crate is in its source package on crates.io and in its repository.\n");
        console.log(rows.join("\n"));
      });' "$triple" >"$dest"
}

# Common part of an archive: icon, notices, server, web.
stage_common() {
  local app=$1
  mkdir -p "$app/runtime" "$app/server" "$app/web"
  cp "$root/desktop/src-tauri/icons/128x128.png" "$app/icon.png"
  cp "$root/LICENSE" "$root/NOTICE.md" "$app/"
  cp "$work/server/server.mjs" "$work/server/server.mjs.LEGAL.txt" "$app/server/"
  cp -r "$work/server/migrations" "$app/server/"
  cp -r "$work/server/translate" "$app/server/"
  cp -r "$root/dist/web/." "$app/web/"
}

checksum() {
  (cd "$out" && sha256sum "$1" >"$1.sha256")
  echo "package: wrote $out/$1 (+ .sha256)"
}

if want linux; then
  tarball=$(fetch_node "node-v$node_ver-linux-x64.tar.xz")
  stage="$work/linux"
  app="$stage/Questlog"
  stage_common "$app"
  rust_notices x86_64-unknown-linux-gnu "$app/THIRD-PARTY-RUST.txt"
  install -m 755 "${CARGO_TARGET_DIR:-$root/desktop/src-tauri/target}/release/Questlog" "$app/Questlog"
  tar -xJf "$tarball" -C "$work" "node-v$node_ver-linux-x64/bin/node" "node-v$node_ver-linux-x64/LICENSE"
  install -m 755 "$work/node-v$node_ver-linux-x64/bin/node" "$app/runtime/node"
  install -m 644 "$work/node-v$node_ver-linux-x64/LICENSE" "$app/runtime/LICENSE"
  name="Questlog-$version-linux-x64.tar.gz"
  rm -f "$out/$name"
  tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner -czf "$out/$name" Questlog
  checksum "$name"
fi

if want win; then
  zipfile=$(fetch_node "node-v$node_ver-win-x64.zip")
  stage="$work/win"
  app="$stage/Questlog"
  stage_common "$app"
  rust_notices x86_64-pc-windows-msvc "$app/THIRD-PARTY-RUST.txt"
  install -m 755 "$QUESTLOG_WIN_EXE" "$app/Questlog.exe"
  unzip -q "$zipfile" "node-v$node_ver-win-x64/node.exe" "node-v$node_ver-win-x64/LICENSE" -d "$work"
  install -m 755 "$work/node-v$node_ver-win-x64/node.exe" "$app/runtime/node.exe"
  install -m 644 "$work/node-v$node_ver-win-x64/LICENSE" "$app/runtime/LICENSE"
  name="Questlog-$version-win-x64.zip"
  rm -f "$out/$name"
  (cd "$stage" && zip -qrX "$out/$name" Questlog)
  checksum "$name"
fi

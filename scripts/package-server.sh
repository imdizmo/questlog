#!/usr/bin/env bash
# Builds the standalone Questlog server archives (no desktop shell):
#   scripts/package-server.sh [--dir] [--version-from-package] [<vX.Y.Z[-suffix]>] <outDir> [linux-x64|linux-arm64|win-x64|all]
#
# --version-from-package  takes the version from package.json "version" instead of the <vX.Y.Z> argument.
# --dir                   leaves the unpacked folder <outDir>/questlog-server-<rid>/ (runtime/, server/, web/, LICENSE,
#                         NOTICE.md, README.txt) instead of an archive, for a packaging repository that wraps it.
#
# Writes <outDir>/questlog-server-vX.Y.Z-linux-x64.tar.gz, ...-linux-arm64.tar.gz and ...-win-x64.zip, each with a
# .sha256 beside it. Each archive has one top folder questlog-server/ with runtime/node[.exe] (+ Node's LICENSE),
# server/server.mjs (+ .LEGAL.txt, migrations/), web/, LICENSE, NOTICE.md and README.txt. The server is a JS bundle,
# so all three are built on any Linux machine; only the Node binary differs. Run `pnpm build` first (it writes
# dist/web). Node version: scripts/node-version.txt, fetched and verified by scripts/lib/node-dist.sh.
set -euo pipefail

die() { echo "package-server: $*" >&2; exit 1; }

dir_mode=0
from_pkg=0
args=()
for a in "$@"; do
  case "$a" in
    --dir) dir_mode=1 ;;
    --version-from-package) from_pkg=1 ;;
    -*) die "unknown option '$a'" ;;
    *) args+=("$a") ;;
  esac
done
usage() { echo "usage: $0 [--dir] [--version-from-package] [<vX.Y.Z>] <outDir> [linux-x64|linux-arm64|win-x64|all]" >&2; exit 2; }
root=$(cd "$(dirname "$0")/.." && pwd)
if ((from_pkg)); then
  [[ ${#args[@]} -ge 1 && ${#args[@]} -le 2 ]] || usage
  version="v$(node -p 'require(process.argv[1]).version' "$root/package.json")"
  out=${args[0]}
  target=${args[1]:-all}
else
  [[ ${#args[@]} -ge 2 && ${#args[@]} -le 3 ]] || usage
  version=${args[0]}
  out=${args[1]}
  target=${args[2]:-all}
fi
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "version must look like v1.2.3, got '$version'"
case "$target" in linux-x64 | linux-arm64 | win-x64 | all) ;; *) die "target must be linux-x64, linux-arm64, win-x64 or all, got '$target'" ;; esac
want() { [[ "$target" == all || "$target" == "$1" ]]; }
if want win-x64; then
  command -v unzip >/dev/null || die "win-x64 needs unzip on PATH"
  ((dir_mode)) || command -v zip >/dev/null || die "win-x64 archives need zip on PATH"
fi

# shellcheck source=lib/node-dist.sh
source "$root/scripts/lib/node-dist.sh"
[[ -f "$root/dist/web/index.html" ]] || die "dist/web is missing; run 'pnpm build' first"
cap() {
  if [[ -n "${QUESTLOG_NO_CAP:-}" ]]; then "$@"; else systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 "$@"; fi
}

umask 022
mkdir -p "$out" "$dist_cache" "$HOME/.cache/gametracker/scratch"
out=$(cd "$out" && pwd)
work=$(mktemp -d "$HOME/.cache/gametracker/scratch/package-server.XXXXXX")
trap 'rm -rf "$work"' EXIT

echo "package-server: bundling the server"
(cd "$root" && cap node scripts/build-server.mjs "$work/server")

write_readme() {
  cat >"$1" <<'README'
Questlog server
===============

A standalone Questlog server: Node.js is included, nothing else needs to be installed.

Start (from this folder; open the printed address in a browser):

  Linux shell:           ./runtime/node server/server.mjs
  Windows (cmd):         runtime\node.exe server\server.mjs
  Windows (PowerShell):  .\runtime\node.exe server\server.mjs

The server prints "QUESTLOG_LISTENING <port>" once it accepts connections.
GET /healthz answers 200 when it is up.

Configuration is by environment variables only:

  PORT                  TCP port to listen on (default 8780).
  JT_HOST               Address to bind (default: all interfaces).
  JT_DB                 SQLite database file (default data/jt.db, relative to the current folder).
  JT_FILES              Folder for uploaded attachments (default data/files).
  JT_WEB                Folder with the web app (optional: the web folder next to server/ is used by default).
  JT_HOSTS              Extra allowed Host header values, comma separated (host[:port]).
  JT_TAILSCALE_AUTH     Set to 1 to sign users in through Tailscale.
  JT_TAILSCALE_SOCKET   Path of the tailscaled socket used for that sign-in.
  JT_TEAM_FILE          Path of a JSON file the server keeps in sync with the team members.
  JATIFY_ADMIN_TOKEN    Token that lets a local process manage team members through the team API.

Keep the database and files folders somewhere you back up. To update, stop the server, replace this folder's
runtime, server and web folders with the new release's and start it again with the same variables.

Licences: LICENSE and NOTICE.md (Questlog), runtime/LICENSE (Node.js), server/server.mjs.LEGAL.txt (npm packages
in the server bundle) and web/THIRD-PARTY-WEB.txt (npm packages in the web app).
README
}

stage_common() {
  local app=$1
  mkdir -p "$app/runtime" "$app/server" "$app/web"
  cp "$root/LICENSE" "$root/NOTICE.md" "$app/"
  cp "$work/server/server.mjs" "$work/server/server.mjs.LEGAL.txt" "$app/server/"
  cp -r "$work/server/migrations" "$app/server/"
  cp -r "$root/dist/web/." "$app/web/"
  write_readme "$app/README.txt"
}

# Archive mode: tars/zips the staged folder (done by the caller). Dir mode: moves it to <out>/questlog-server-<rid>.
publish_dir() {
  rm -rf "$out/questlog-server-$2"
  mv "$1/questlog-server" "$out/questlog-server-$2"
  echo "package-server: wrote $out/questlog-server-$2/"
}

checksum() {
  (cd "$out" && sha256sum "$1" >"$1.sha256")
  echo "package-server: wrote $out/$1 (+ .sha256)"
}

linux_archive() {
  local arch=$1 tarball stage app name
  tarball=$(fetch_node "node-v$node_ver-linux-$arch.tar.xz")
  stage="$work/linux-$arch"
  app="$stage/questlog-server"
  stage_common "$app"
  tar -xJf "$tarball" -C "$work" "node-v$node_ver-linux-$arch/bin/node" "node-v$node_ver-linux-$arch/LICENSE"
  install -m 755 "$work/node-v$node_ver-linux-$arch/bin/node" "$app/runtime/node"
  install -m 644 "$work/node-v$node_ver-linux-$arch/LICENSE" "$app/runtime/LICENSE"
  if ((dir_mode)); then publish_dir "$stage" "linux-$arch"; return; fi
  name="questlog-server-$version-linux-$arch.tar.gz"
  rm -f "$out/$name"
  tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner -czf "$out/$name" questlog-server
  checksum "$name"
}

want linux-x64 && linux_archive x64
want linux-arm64 && linux_archive arm64

if want win-x64; then
  zipfile=$(fetch_node "node-v$node_ver-win-x64.zip")
  stage="$work/win-x64"
  app="$stage/questlog-server"
  stage_common "$app"
  unzip -q "$zipfile" "node-v$node_ver-win-x64/node.exe" "node-v$node_ver-win-x64/LICENSE" -d "$work"
  install -m 755 "$work/node-v$node_ver-win-x64/node.exe" "$app/runtime/node.exe"
  install -m 644 "$work/node-v$node_ver-win-x64/LICENSE" "$app/runtime/LICENSE"
  if ((dir_mode)); then
    publish_dir "$stage" win-x64
  else
    name="questlog-server-$version-win-x64.zip"
    rm -f "$out/$name"
    (cd "$stage" && zip -qrX "$out/$name" questlog-server)
    checksum "$name"
  fi
fi

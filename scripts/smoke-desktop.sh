#!/usr/bin/env bash
# Smoke test for a packaged Questlog Linux archive:
#   scripts/smoke-desktop.sh <Questlog-vX.Y.Z-linux-x64.tar.gz>
#
# Unpacks the archive like the launcher does, starts Questlog on a private Xvfb :98 with its own D-Bus session and
# scratch XDG dirs, and checks: the archive layout (with the licence notices), desktop.json + /healthz, nothing
# listening on the LAN IP, a non-blank window, single instance (also when the second launch has no D-Bus), and that
# the server dies with the shell. Prints the peak RSS of shell + WebKit + node.
# Exits non-zero on any failed check. Everything it starts is killed by PID and the scratch dir is deleted.
#
# Isolation is enforced here, not left to the caller: the app never sees the user's WAYLAND_DISPLAY, DISPLAY,
# D-Bus session or XDG dirs, so no window or portal can reach the real desktop.
#
# SMOKE_SHOT_OUT=<file.png> keeps a copy of the screenshot (the scratch copy is deleted).
set -euo pipefail

SELF=$(realpath "$0")
SCRATCH_ROOT="${HOME}/.cache/gametracker/scratch"
DISPLAY_NUM=98
# The launcher's memory cap; the app runs under it here too.
MEMORY_MAX=1536M

die() { echo "smoke: FAIL: $*" >&2; exit 1; }
ok() { echo "smoke: ok: $*"; }

# ---------------------------------------------------------------------------------------------------------------
# Inner part: runs inside dbus-run-session with the isolated environment.
# ---------------------------------------------------------------------------------------------------------------
inner() {
  local S=$1
  # stderr here is the session log (D-Bus, portal and GTK noise); results go to stdout.
  die() { echo "smoke: FAIL: $*"; exit 1; }
  # Refuse to run with anything that could reach the user's desktop.
  [[ -z "${WAYLAND_DISPLAY:-}" ]] || die "WAYLAND_DISPLAY is set"
  [[ "${DISPLAY:-}" == ":${DISPLAY_NUM}" ]] || die "DISPLAY is not :${DISPLAY_NUM}"
  [[ "${GDK_BACKEND:-}" == "x11" ]] || die "GDK_BACKEND is not x11"
  [[ "${XDG_RUNTIME_DIR:-}" == "$S"/* && "${XDG_DATA_HOME:-}" == "$S"/* ]] || die "XDG dirs are not in scratch"
  [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" && "$DBUS_SESSION_BUS_ADDRESS" != "unix:path=/run/user/"* ]] \
    || die "not on a private D-Bus session"

  local app="$S/unpack/Questlog/Questlog"
  local server_js="$S/unpack/Questlog/server/server.mjs"
  local data="$XDG_DATA_HOME/questlog"

  # PIDs of node processes running this archive's server.mjs.
  server_pids() {
    local p
    for p in /proc/[0-9]*; do
      tr '\0' ' ' 2>/dev/null <"$p/cmdline" | grep -qF -- "$server_js" && echo "${p#/proc/}"
    done
    return 0
  }
  # All descendants of a PID.
  descendants() {
    local kids k
    kids=$(ps -o pid= --ppid "$1" 2>/dev/null || true)
    for k in $kids; do
      echo "$k"
      descendants "$k"
    done
  }

  "$app" >"$S/questlog-1.log" 2>&1 &
  local shell_pid=$!
  echo "smoke: started Questlog pid $shell_pid"

  # desktop.json (seeded with "server": "local") gets a port, then /healthz.
  local port="" i
  for ((i = 0; i < 300; i++)); do
    [[ -s "$data/desktop.json" ]] && port=$(grep -oE '"port":[[:space:]]*[0-9]+' "$data/desktop.json" | grep -oE '[0-9]+$' || true)
    [[ -n "$port" ]] && break
    kill -0 "$shell_pid" 2>/dev/null || die "Questlog exited early: $(tail -5 "$S/questlog-1.log")"
    sleep 0.1
  done
  [[ -n "$port" ]] || die "no desktop.json with a port after 30 s"
  ok "desktop.json port $port"

  local health=""
  for ((i = 0; i < 300; i++)); do
    health=$(curl -s --max-time 1 "http://127.0.0.1:$port/healthz" || true)
    [[ "$health" == "ok" ]] && break
    sleep 0.1
  done
  [[ "$health" == "ok" ]] || die "/healthz on 127.0.0.1:$port did not answer ok: $(tail -5 "$data/logs/server.log" 2>/dev/null)"
  ok "/healthz on 127.0.0.1:$port"

  # Nothing on the LAN address.
  local lan rc=0
  lan=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
  if [[ -z "$lan" ]]; then
    echo "smoke: SKIP: no LAN IPv4 address to probe"
  else
    curl -s --max-time 3 -o /dev/null "http://$lan:$port/healthz" || rc=$?
    [[ $rc -eq 7 ]] || die "connection to $lan:$port was not refused (curl exit $rc)"
    ok "connection to LAN $lan:$port refused"
  fi

  # Let the UI load, then the window must not be blank.
  sleep 5
  import -display ":${DISPLAY_NUM}" -window root "$S/shot.png"
  local colors
  colors=$(magick "$S/shot.png" -format '%k' info:)
  [[ "$colors" -gt 1 ]] || die "screenshot is blank ($colors colour)"
  ok "screenshot has $colors colours"
  # The workspace strip docks beside the page (main.rs `dock`); a Tauri that packs child webviews differently fails here.
  ! grep -q "could not dock" "$S/questlog-1.log" || die "the workspace strip was not docked: $(grep "could not dock" "$S/questlog-1.log")"
  ok "workspace strip docked"
  if [[ -n "${SMOKE_SHOT_OUT:-}" ]]; then cp "$S/shot.png" "$SMOKE_SHOT_OUT"; fi

  # Second launch hands over to the first; still one server.
  "$app" >"$S/questlog-2.log" 2>&1 &
  local second_pid=$!
  sleep 5
  local count
  count=$(server_pids | wc -l)
  [[ "$count" -eq 1 ]] || die "$count server.mjs processes after a second launch, expected 1"
  if kill -0 "$second_pid" 2>/dev/null; then
    kill -9 "$second_pid" 2>/dev/null || true
    die "second Questlog (pid $second_pid) is still running"
  fi
  ok "second launch exited, one server.mjs"

  # A second launch that cannot reach the first over D-Bus (the single-instance plugin then lets it through) must
  # stop at the data folder's lock: an "already running" page, no second server, desktop.json untouched.
  local before after third_pid
  before=$(cat "$data/desktop.json")
  DBUS_SESSION_BUS_ADDRESS="unix:path=$S/run/no-such-bus" "$app" >"$S/questlog-3.log" 2>&1 &
  third_pid=$!
  for ((i = 0; i < 100; i++)); do
    grep -q "already running" "$S/questlog-3.log" 2>/dev/null && break
    kill -0 "$third_pid" 2>/dev/null || break
    sleep 0.1
  done
  grep -q "already running" "$S/questlog-3.log" \
    || die "launch without D-Bus did not report 'already running': $(tail -5 "$S/questlog-3.log")"
  sleep 2
  count=$(server_pids | wc -l)
  [[ "$count" -eq 1 ]] || die "$count server.mjs processes after a launch without D-Bus, expected 1"
  after=$(cat "$data/desktop.json")
  [[ "$before" == "$after" ]] || die "desktop.json changed by the launch without D-Bus: $before -> $after"
  kill -0 "$third_pid" 2>/dev/null || die "launch without D-Bus exited instead of showing the page"
  kill -9 "$third_pid" 2>/dev/null || true
  wait "$third_pid" 2>/dev/null || true
  ok "launch without D-Bus stopped at the lock: already-running page, one server.mjs, desktop.json unchanged"

  # Peak RSS of the shell and everything under it (WebKit processes, node), read before the kill.
  local total=0 pid hwm name
  for pid in "$shell_pid" $(descendants "$shell_pid"); do
    hwm=$(awk '/^VmHWM:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)
    [[ -n "$hwm" ]] || continue
    name=$(cat "/proc/$pid/comm" 2>/dev/null || echo "?")
    printf 'smoke: peak RSS %-20s pid %-8s %6d MB\n' "$name" "$pid" $((hwm / 1024))
    total=$((total + hwm))
  done
  printf 'smoke: PEAK RSS TOTAL (shell + WebKit + node): %d MB\n' $((total / 1024))

  # The server must die with the shell.
  kill -9 "$shell_pid"
  local left=""
  for ((i = 0; i < 50; i++)); do
    left=$(server_pids)
    [[ -z "$left" ]] && break
    sleep 0.1
  done
  [[ -z "$left" ]] || die "server.mjs still running 5 s after kill -9 of the shell: $left"
  ok "server.mjs gone after kill -9 of the shell"
  echo "smoke: all checks passed"
}

if [[ "${1:-}" == "--inner" ]]; then
  inner "$2"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------
# Outer part: unpack, private X server, isolated launch, cleanup.
# ---------------------------------------------------------------------------------------------------------------
[[ $# -eq 1 ]] || { echo "usage: $0 <Questlog-vX.Y.Z-linux-x64.tar.gz>" >&2; exit 2; }
archive=$1
[[ -f "$archive" ]] || die "no archive at $archive"
archive=$(realpath "$archive")
for tool in Xvfb import magick dbus-run-session curl ip systemd-run; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done
[[ ! -e "/tmp/.X${DISPLAY_NUM}-lock" && ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]] \
  || die "display :${DISPLAY_NUM} is already in use"

mkdir -p "$SCRATCH_ROOT"
S=$(mktemp -d "$SCRATCH_ROOT/smoke.XXXXXX")
mkdir -p "$S/unpack" "$S/data/questlog" "$S/config" "$S/cache" "$S/run"
chmod 700 "$S/run"
# A fresh data folder asks where the workspace is; this test is about the local server.
printf '{\n  "server": "local"\n}\n' >"$S/data/questlog/desktop.json"
xvfb_pid=""

# PIDs (not ours) whose environment mentions the scratch dir: the app, WebKit, D-Bus and anything it activated.
scratch_pids() {
  local p
  for p in /proc/[0-9]*; do
    [[ "${p#/proc/}" == "$$" ]] && continue
    grep -qzF -- "$S" "$p/environ" 2>/dev/null && echo "${p#/proc/}"
  done
  return 0
}

cleanup() {
  local rc=$? pids p
  set +e
  pids=$(scratch_pids)
  for p in $pids; do [[ "$p" == "$xvfb_pid" ]] || kill -9 "$p" 2>/dev/null; done
  # SIGTERM, so Xvfb removes its lock and socket.
  if [[ -n "$xvfb_pid" ]]; then
    kill "$xvfb_pid" 2>/dev/null
    wait "$xvfb_pid" 2>/dev/null
  fi
  sleep 0.5
  pids=$(scratch_pids)
  if [[ -n "$pids" ]]; then
    echo "smoke: FAIL: processes left behind: $pids" >&2
    rc=1
  fi
  if [[ -n "$xvfb_pid" ]] && kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "smoke: FAIL: Xvfb $xvfb_pid still running" >&2
    rc=1
  fi
  if [[ $rc -ne 0 && -s "$S/session.log" ]]; then
    echo "smoke: last lines of the session log:" >&2
    tail -n 20 "$S/session.log" >&2
  fi
  rm -rf "$S"
  [[ $rc -eq 0 ]] && echo "smoke: cleaned up (no processes left, scratch deleted)"
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

tar -xzf "$archive" --no-same-owner -C "$S/unpack"
[[ -x "$S/unpack/Questlog/Questlog" ]] || die "archive has no executable Questlog/Questlog"
for f in LICENSE NOTICE.md THIRD-PARTY-RUST.txt icon.png runtime/node runtime/LICENSE server/server.mjs \
  server/server.mjs.LEGAL.txt web/index.html; do
  [[ -s "$S/unpack/Questlog/$f" ]] || die "archive has no Questlog/$f"
done
ls "$S/unpack/Questlog/server/migrations/"*.sql >/dev/null 2>&1 || die "archive has no server/migrations/*.sql"
ok "unpacked $(basename "$archive")"

# The scratch path in Xvfb's environment lets the cleanup find it too.
SMOKE_SCRATCH="$S" Xvfb ":${DISPLAY_NUM}" -screen 0 1280x800x24 -nolisten tcp >"$S/xvfb.log" 2>&1 &
xvfb_pid=$!
for ((i = 0; i < 100; i++)); do
  [[ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]] && break
  kill -0 "$xvfb_pid" 2>/dev/null || die "Xvfb failed: $(cat "$S/xvfb.log")"
  sleep 0.1
done
[[ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]] || die "Xvfb :${DISPLAY_NUM} did not come up"

# systemd-run needs the user's bus, so it goes first; everything after `env` is isolated.
systemd-run --user --scope -q -p MemoryMax="$MEMORY_MAX" -p MemorySwapMax=0 \
  env -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS -u XAUTHORITY -u XDG_SESSION_TYPE -u XDG_CURRENT_DESKTOP \
  -u DESKTOP_SESSION -u SESSION_MANAGER -u JATIFY_TEAM \
  DISPLAY=":${DISPLAY_NUM}" GDK_BACKEND=x11 \
  XDG_DATA_HOME="$S/data" XDG_CONFIG_HOME="$S/config" XDG_CACHE_HOME="$S/cache" XDG_RUNTIME_DIR="$S/run" \
  SMOKE_SCRATCH="$S" \
  dbus-run-session -- bash "$SELF" --inner "$S" 2>"$S/session.log"

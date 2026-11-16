#!/usr/bin/env bash
# Exports the public (open-source) tree of Questlog and audits it:
#   scripts/public-tree.sh <outDir>
#
# 1. `git archive HEAD` into <outDir> (tracked, committed files only), then deletes the excluded paths below, agent
#    instruction files at any depth, and build output.
# 2. Audits what is left for product names that must not appear, personal paths, LAN/VPN addresses, personal mail
#    addresses, tokens and keys, and session links. Any hit is listed as file:line and the script fails; the tree is
#    left in <outDir> for inspection, without a git repo.
# 3. On a clean audit: `git init -b main` in <outDir> and one commit, "Questlog <version>", authored by the public GitHub
#    identity (imdizmo, noreply address; override with PUBLIC_GIT_NAME/PUBLIC_GIT_EMAIL), with no trailers. Prints the file list.
#
# It never pushes and never adds a remote. <outDir> must not exist yet or be empty.
set -euo pipefail

die() { echo "public-tree: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: scripts/public-tree.sh <outDir>"
REPO=$(git -C "$(dirname "$(realpath "$0")")" rev-parse --show-toplevel)
OUT=$(realpath -m "$1")

case "$OUT/" in "$REPO"/*) die "<outDir> must be outside the repository ($REPO)";; esac
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT")" ]; then die "$OUT exists and is not empty"; fi
mkdir -p "$OUT"

# ---- 1. export --------------------------------------------------------------------------------------------------
git -C "$REPO" archive --format=tar HEAD | tar -x -C "$OUT"

for p in private docs .superpowers .worktrees tracker.py test_tracker.py static data node_modules dist \
         desktop/src-tauri/target desktop/src-tauri/gen; do
  rm -rf "${OUT:?}/$p"
done
find "$OUT" \( -name CLAUDE.md -o -name AGENTS.md -o -name .claude \) -prune -exec rm -rf {} +

# ---- 2. audit ---------------------------------------------------------------------------------------------------
# Patterns use a bracket somewhere so this script never matches itself.
PATTERNS=(
  '[c]odecks'
  '/[h]ome/'
  '19[2]\.168\.'
  '10[0]\.113\.'
  '[a-z0-9-]+\.[t]s\.net'
  '10[0]\.90\.171\.'
  '@[g]mail\.com'
  '[g]hp_|[g]ithub_pat_|[s]k_live|[s]k_test|[x]ox[bp]-|-----[B]EGIN'
  '[c]laude\.ai/code/session'
)
hits=$(
  cd "$OUT"
  for pat in "${PATTERNS[@]}"; do
    # Text files: file:line. Binary files: named once.
    grep -rnIiE -- "$pat" . || true
    grep -rliaE -- "$pat" . | while read -r f; do grep -qI . "$f" 2>/dev/null || echo "$f: (binary file matches)"; done || true
  done
  find . \( -name CLAUDE.md -o -name AGENTS.md -o -name .claude \) -printf '%p: agent instruction file\n'
)

# Known, intended hits, each excused for one exact line: fake test credentials, the self-signed test certificate,
# private addresses that tests check are refused, and a UI placeholder. An entry is "<file> <sha256 of the whole line>"
# (a hash, so this script never matches itself). Any change to such a line, including an extra leak on it, fails.
ALLOW=(
  'tests/billing.test.ts 7388965fd29bef6194895d1fb9410018f86b6f0b8dcd9e8ef019d62d6553d331'           # fake Stripe key
  'tests/billing.test.ts 2914e99e1b581c8276bb84376f4b1cdcedf71464482cb7a1b6cb00dd60e37a8d'           # fake Stripe key
  'tests/danger-zone.test.ts 4beb65b373b63a49ad56980c52aeb2468330c7857ee35cac9bbd126e97617c7d'       # fake Stripe key
  'tests/integrations-chat.test.ts ad72fe144114a386ac4b36326e6ffc79f074c10572191ac659956fadec39227d' # fake Slack token
  'web/src/views/settings/Slack.tsx 4b0771ca9b31e829cb2fbb55145dfad80b6d557b4158c4538485141ef5ea887a' # token placeholder
  'tests/fixtures/smtp-test-cert.pem ddddb6cbd348658f02fa6c8a46b6f51cf6b6bbe22d54fc6a4f0e3b3f59c5d012' # test cert
  'tests/fixtures/smtp-test-key.pem 3021d90eb9437b2d8f30e8363695c4418b5e5f1870801b5c317e9398ee0f572d'  # test key
  'tests/covers.test.ts 9c947c7b618b0360208764f6aa941eebce34e75f5856d786ef76e412d05d38ae'            # refused address
  'tests/covers.test.ts 3cfa31b94ee61e5e42d57bbebef4e195da4aacd9d4062d3827dbc54e1fe4ddf5'            # refused address
  'tests/markdown.test.ts 99b75635a1bf8cf5ceba5a584dba68045c1422bcee679d7d749d4c8e78a9f30b'          # refused address
  'tests/markdown.test.ts debbd42902895cd4711b8546b31a58adbc5f0e73b7cc7a8d7baf44c9d61ab231'          # refused address
)
allowed() { # $1 = "./file:line:text" (a text-file hit; binary hits are never excused)
  local rest=${1#./} file text sum
  file=${rest%%:*}; text=${rest#*:}; text=${text#*:}
  sum=$(printf '%s' "$text" | sha256sum); sum=${sum%% *}
  printf '%s\n' "${ALLOW[@]}" | grep -qxF -- "$file $sum"
}
if [ -n "$hits" ]; then
  kept=""
  while IFS= read -r h; do allowed "$h" || kept+="$h"$'\n'; done <<< "$hits"
  hits=${kept%$'\n'}
fi

# ---- file list ----------------------------------------------------------------------------------------------------
files=$(cd "$OUT" && find . -type f ! -path './.git/*' | sed 's|^\./||' | LC_ALL=C sort)
echo "== public tree: $OUT"
echo "$files"
echo "== $(echo "$files" | grep -c .) files"

if [ -n "$hits" ]; then
  echo "== audit: FAIL"
  echo "$hits" | sed 's|^\./||' | LC_ALL=C sort -u
  exit 1
fi
echo "== audit: clean"

# ---- 3. one commit ----------------------------------------------------------------------------------------------
# The public identity, never this repository's git config (that holds a real name and address).
name=${PUBLIC_GIT_NAME:-imdizmo}
email=${PUBLIC_GIT_EMAIL:-25664907+imdizmo@users.noreply.github.com}
version=$(node -p 'require(process.argv[1]).version' "$OUT/package.json")
cd "$OUT"
git init -q -b main
git add -A
# No hooks (a commit-msg hook could add trailers); the message is exactly "Questlog <version>".
GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
  git -c core.hooksPath=/dev/null commit -q --no-verify -m "Questlog $version"
echo "== commit: $(git log --oneline | wc -l) commit(s), $(git log -1 --format='%h %s (%an <%ae>)')"

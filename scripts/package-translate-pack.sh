#!/usr/bin/env bash
# Builds the Questlog translation language pack (English <-> Italian), one archive for every platform:
#   scripts/package-translate-pack.sh <vX.Y.Z[-suffix]> <outDir>
#
# Writes <outDir>/questlog-translate-models-vX.Y.Z.tar.gz and .sha256. The archive has one top folder, models/, with
# models/translate/ inside: engine.mjs (the Bergamot WASM wrapper from scripts/translate-pack/, bundled with esbuild),
# the Bergamot WASM engine, the Firefox en-it and it-en models, pack.json and the licence files. Unpack it beside the
# server/ folder. Needs network once: every download is pinned by sha256 below and cached in
# ~/.cache/gametracker/translate-dist/<sha256>/. Run `pnpm install` first (esbuild).
set -euo pipefail

die() { echo "package-translate-pack: $*" >&2; exit 1; }
[[ $# -eq 2 ]] || die "usage: $0 <vX.Y.Z> <outDir>"
version=$1
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "version must look like v1.2.3, got '$version'"
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)

# name  sha256  url. Engine: @browsermt/bergamot-translator 0.4.9 (MPL-2.0). Models: Firefox Translations, served by
# Mozilla Remote Settings (en-it 2.1, it-en 2.0; MPL-2.0). Licence: mozilla/firefox-translations-models LICENSE.
CDN=https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models
DOWNLOADS=(
  "engine.tgz 9011be93222d839d7448ffdf00549d53ce8f541fd782ffc79779d1756397c41f https://registry.npmjs.org/@browsermt/bergamot-translator/-/bergamot-translator-0.4.9.tgz"
  "model.enit.intgemm.alphas.bin 248f47568788ecc351da7e5e07064d4153b4f71e011364ae2c931ffeec4d1cc2 $CDN/29ae0d70-5e37-49e8-8da6-3e2c58da61d1.bin"
  "lex.50.50.enit.s2t.bin 8b21914804625b2777dae7fdb636eb78f02a3eb8b7bceaa50f29ac740961da93 $CDN/3730ff60-2291-4c87-888d-2dc4593b20db.bin"
  "vocab.enit.spm 3ef0211d4ae6db21440892f180f2019fe2bfc110a330ffa9d2eca9665e4f2bc5 $CDN/d9d5ffa9-b919-4491-9ab6-3dec34459768.spm"
  "model.iten.intgemm.alphas.bin 21b70978ce2f3b4da7a06b5de86a09abe3acd30b9eee1b2ebb3582b9bad790bf $CDN/a6e3de84-6612-4546-a4ef-b658ee23ca08.bin"
  "lex.50.50.iten.s2t.bin 0700d6d70b30490e68ff9deca0b45b80310745b491855bde3a13e1692d0cbce1 $CDN/122ac310-0f7b-40d5-b49d-bcee81077c85.bin"
  "vocab.iten.spm 3ef0211d4ae6db21440892f180f2019fe2bfc110a330ffa9d2eca9665e4f2bc5 $CDN/51b5a437-9daa-481e-a9bc-311f2b3f490c.spm"
  "LICENSE-MPL-2.0.txt 1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5 https://raw.githubusercontent.com/mozilla/firefox-translations-models/main/LICENSE"
)

dist="$HOME/.cache/gametracker/translate-dist"
# Prints the cached path of download <name>, fetching it into its own folder named by its sha256 and checking it.
fetch() {
  local name sum url d
  for e in "${DOWNLOADS[@]}"; do
    read -r name sum url <<<"$e"
    [[ "$name" == "$1" ]] || continue
    d="$dist/$sum"
    mkdir -p "$d"
    if [[ ! -s "$d/$name" ]]; then
      echo "package-translate-pack: downloading $name" >&2
      curl -fsSL --retry 3 -o "$d/$name.part" "$url" && mv "$d/$name.part" "$d/$name"
    fi
    if ! echo "$sum  $d/$name" | sha256sum -c --status; then
      rm -f "$d/$name"
      die "checksum mismatch for $name (deleted from the cache; run again to re-download)"
    fi
    echo "$d/$name"
    return
  done
  die "no download named $1"
}

umask 022
mkdir -p "$HOME/.cache/gametracker/scratch"
work=$(mktemp -d "$HOME/.cache/gametracker/scratch/translate-pack.XXXXXX")
trap 'rm -rf "$work"' EXIT
pack="$work/stage/models/translate"
mkdir -p "$pack/enit" "$pack/iten" "$work/engine"

tar -xzf "$(fetch engine.tgz)" -C "$work/engine" package/worker/bergamot-translator-worker.js \
  package/worker/bergamot-translator-worker.wasm package/package.json
install -m 644 "$work"/engine/package/worker/bergamot-translator-worker.{js,wasm} "$pack/"
for d in enit iten; do
  for f in "model.$d.intgemm.alphas.bin" "lex.50.50.$d.s2t.bin" "vocab.$d.spm"; do
    install -m 644 "$(fetch "$f")" "$pack/$d/$f"
  done
done
install -m 644 "$(fetch LICENSE-MPL-2.0.txt)" "$pack/LICENSE-MPL-2.0.txt"

(cd "$root" && pnpm exec esbuild scripts/translate-pack/engine.mjs --bundle --platform=node --format=esm \
  --target=node22 --outfile="$pack/engine.mjs" --log-level=warning)

cat >"$pack/NOTICE.txt" <<'NOTICE'
Questlog translation language pack (English <-> Italian)

Translation engine: Bergamot translator (Mozilla and the Bergamot project), @browsermt/bergamot-translator 0.4.9,
compiled to WebAssembly: bergamot-translator-worker.js and .wasm. Licensed under the Mozilla Public License 2.0.
Source: https://github.com/browsermt/bergamot-translator

Models: the Firefox Translations models en-it (version 2.1) and it-en (version 2.0), in enit/ and iten/, from
https://github.com/mozilla/firefox-translations-models, licensed under the Mozilla Public License 2.0. They were
trained on OPUS parallel corpora.

The full licence text is in LICENSE-MPL-2.0.txt. The files above are unmodified. engine.mjs is Questlog's own small
wrapper (MIT, see the Questlog LICENSE).
NOTICE
printf '{ "version": "%s", "langs": ["en", "it"] }\n' "${version#v}" >"$pack/pack.json"

name="questlog-translate-models-$version.tar.gz"
rm -f "$out/$name" "$out/$name.sha256"
tar -C "$work/stage" --sort=name --owner=0 --group=0 --numeric-owner -czf "$out/$name" models
(cd "$out" && sha256sum "$name" >"$name.sha256")
echo "package-translate-pack: wrote $out/$name (+ .sha256)"

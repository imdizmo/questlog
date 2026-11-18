# Shared by package-desktop.sh and package-server.sh (sourced, not run).
# Reads the Node runtime version from scripts/node-version.txt into $node_ver and offers fetch_node, which
# downloads a Node release file into ~/.cache/gametracker/node-dist/ and checks it against nodejs.org's
# SHASUMS256.txt. Needs $root (the repository root) and die() from the caller.

node_ver=$(tr -d '[:space:]' <"$root/scripts/node-version.txt")
node_ver=${node_ver#v}
[[ "$node_ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bad version in scripts/node-version.txt: '$node_ver'"
dist_cache="$HOME/.cache/gametracker/node-dist"

# Downloads into the shared cache once; every use re-checks the file against SHASUMS256.txt. Prints the path.
fetch_node() {
  local file=$1 base="https://nodejs.org/dist/v$node_ver"
  local dir="$dist_cache/v$node_ver"
  mkdir -p "$dir"
  if [[ ! -s "$dir/SHASUMS256.txt" ]]; then
    curl -fsSL --retry 3 -o "$dir/SHASUMS256.txt.part" "$base/SHASUMS256.txt"
    mv "$dir/SHASUMS256.txt.part" "$dir/SHASUMS256.txt"
  fi
  if [[ ! -s "$dir/$file" ]]; then
    echo "package: downloading $file" >&2
    curl -fsSL --retry 3 -o "$dir/$file.part" "$base/$file"
    mv "$dir/$file.part" "$dir/$file"
  fi
  local line
  line=$(grep -E "^[0-9a-f]{64}  $file\$" "$dir/SHASUMS256.txt") || die "$file is not listed in SHASUMS256.txt"
  if ! (cd "$dir" && echo "$line" | sha256sum -c --status); then
    rm -f "$dir/$file"
    die "checksum mismatch for $file (deleted from the cache; run again to re-download)"
  fi
  echo "$dir/$file"
}

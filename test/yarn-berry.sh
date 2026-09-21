#!/usr/bin/env bash
# Berry detection: the lockfile decides, not .yarnrc.yml. Kept out of audit-eco.sh so it runs
# without pnpm installed.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- yarn classic carrying a .yarnrc.yml is NOT berry ---
# yarn 1 ignores .yarnrc.yml, so its presence says nothing about the lockfile that actually
# resolves. Detecting berry from that file alone locked classic repos out of `audit` entirely.
mkdir "$TMP/classic" && cd "$TMP/classic"
git init -q -b main && git config user.email t@t && git config user.name t
echo '{ "name": "t", "version": "1.0.0", "dependencies": { "minimist": "0.2.0" } }' > package.json
yarn install --silent >/dev/null 2>&1
grep -q "^# yarn lockfile v1$" yarn.lock || { echo "FAIL: fixture is not a classic lockfile"; exit 1; }
printf 'nodeLinker: node-modules\n' > .yarnrc.yml
printf 'node_modules/\n' > .gitignore
git add -A && git commit -qm init
# capture first: die() exits non-zero and pipefail would report that, not grep's verdict
OUT=$(node "$BW" audit 2>&1 || true)
case "$OUT" in *"isn't supported yet"*) echo "FAIL: classic yarn.lock + .yarnrc.yml misdetected as berry"; exit 1;; esac

# --- a real berry lockfile is still refused ---
mkdir "$TMP/berry" && cd "$TMP/berry"
git init -q -b main && git config user.email t@t && git config user.name t
echo '{ "name": "t", "version": "1.0.0" }' > package.json
printf '__metadata:\n  version: 8\n  cacheKey: 10c0\n' > yarn.lock
printf 'nodeLinker: node-modules\n' > .yarnrc.yml
git add -A && git commit -qm init
OUT=$(node "$BW" audit 2>&1 || true)
case "$OUT" in *"isn't supported yet"*) ;; *) echo "FAIL: real berry lockfile was not refused: $OUT"; exit 1;; esac

echo "YARN BERRY OK"

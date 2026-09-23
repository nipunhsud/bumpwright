#!/usr/bin/env bash
# install ladder: clean repos install cleanly; broken peer graphs report the rung that worked.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# clean npm project -> npm ci succeeds, reported as clean
mkdir "$TMP/clean" && cd "$TMP/clean"
printf '{ "name":"c","private":true,"dependencies":{"isarray":"1.0.0"} }' > package.json
npm install --silent >/dev/null 2>&1
OUT=$(node "$BW" install)
echo "$OUT" | grep -q "installed cleanly" || { echo "FAIL: clean install not reported"; echo "$OUT"; exit 1; }
echo "INSTALL CLEAN OK"

# unsatisfiable peer graph -> npm ci/install fail, --legacy-peer-deps rescues it
mkdir "$TMP/peer" && cd "$TMP/peer"
cat > package.json <<'PKG'
{ "name": "p", "private": true,
  "dependencies": { "react": "17.0.2", "@testing-library/react-hooks": "8.0.1" } }
PKG
OUT=$(node "$BW" install 2>&1) || { echo "FAIL: ladder did not recover"; echo "$OUT" | tail -3; exit 1; }
echo "$OUT" | grep -q "installed, but only with" || { echo "FAIL: fallback rung not named"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "does not install with its own lockfile" || { echo "FAIL: finding not surfaced"; exit 1; }
echo "INSTALL LADDER OK"

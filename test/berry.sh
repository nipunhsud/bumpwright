#!/usr/bin/env bash
# yarn berry (v2+): direct vuln bumped on its own branch; transitive pinned via resolutions.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
command -v yarn >/dev/null || { echo "SKIP: yarn not installed"; exit 0; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# direct dependency
mkdir "$TMP/bd" && cd "$TMP/bd"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"bd","private":true,"dependencies":{"minimist":"0.0.8"},"scripts":{"test":"exit 0"} }' > package.json
yarn set version berry >/dev/null 2>&1
yarn install >/dev/null 2>&1
printf '.yarn/\n.pnp.*\n' > .gitignore
git add -A && git commit -qm init
node "$BW" audit >/dev/null 2>&1 || { echo "FAIL: berry audit run failed"; exit 1; }
BR=$(git branch --list 'bumpwright/minimist-*' --format='%(refname:short)' | head -1)
[ -n "$BR" ] || { echo "FAIL: no berry direct branch"; exit 1; }
git show "$BR:package.json" | grep -Eq '"minimist": ?"\^?0\.2\.[1-9]' || { echo "FAIL: not bumped: $(git show $BR:package.json)"; exit 1; }
git log "$BR" -1 --pretty=%B | grep -q "Security: fixes http" || { echo "FAIL: no advisory link"; exit 1; }
echo "BERRY DIRECT OK"

# transitive dependency via --overrides (resolutions)
mkdir "$TMP/bt" && cd "$TMP/bt"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"bt","private":true,"dependencies":{"mkdirp":"0.5.1"},"scripts":{"test":"exit 0"} }' > package.json
yarn set version berry >/dev/null 2>&1
yarn install >/dev/null 2>&1
printf '.yarn/\n.pnp.*\n' > .gitignore
git add -A && git commit -qm init
node "$BW" audit --overrides >/dev/null 2>&1 || { echo "FAIL: berry overrides run failed"; exit 1; }
git rev-parse --verify -q bumpwright/security-overrides >/dev/null || { echo "FAIL: no overrides branch"; exit 1; }
git show bumpwright/security-overrides:package.json | python3 -c "import json,sys; p=json.load(sys.stdin); assert 'minimist' in p.get('resolutions',{}), p.get('resolutions'); print('ok')" >/dev/null || { echo "FAIL: resolutions missing"; exit 1; }
echo "BERRY OVERRIDES OK"

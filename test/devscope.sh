#!/usr/bin/env bash
# dev/prod scope: a vuln reachable only through devDependencies is labelled as such.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# dev-only: vulnerable package sits in devDependencies
mkdir "$TMP/dev" && cd "$TMP/dev"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"d","private":true,"devDependencies":{"minimist":"0.0.8"},"scripts":{"test":"exit 0"} }' > package.json
npm install --silent >/dev/null 2>&1
printf 'node_modules/\n' > .gitignore
git add -A && git commit -qm init
OUT=$(node "$BW" audit 2>&1)
echo "$OUT" | grep -q "dev/build tooling only" || { echo "FAIL: dev-only not labelled"; echo "$OUT" | head -6; exit 1; }
BR=$(git branch --list 'bumpwright/minimist-*' --format='%(refname:short)' | head -1)
[ -n "$BR" ] || { echo "FAIL: no branch"; exit 1; }
git log "$BR" -1 --pretty=%B | grep -q "does not ship to consumers" || { echo "FAIL: scope note missing from commit"; exit 1; }
echo "DEVSCOPE DEV OK"

# prod: same package in dependencies must NOT be labelled dev-only
mkdir "$TMP/prod" && cd "$TMP/prod"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"p","private":true,"dependencies":{"minimist":"0.0.8"},"scripts":{"test":"exit 0"} }' > package.json
npm install --silent >/dev/null 2>&1
printf 'node_modules/\n' > .gitignore
git add -A && git commit -qm init
OUT=$(node "$BW" audit 2>&1)
echo "$OUT" | grep -q "dev/build tooling only" && { echo "FAIL: prod dep mislabelled as dev"; exit 1; }
echo "DEVSCOPE PROD OK"

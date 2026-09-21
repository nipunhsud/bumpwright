#!/usr/bin/env bash
# Python path: pip project, requirements.txt kept truthful, same guardrails.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q -b main && git config user.email t@t && git config user.name t
python3 -m venv .venv >/dev/null
export PATH="$TMP/.venv/bin:$PATH"
python3 -m pip install --quiet six==1.15.0
echo "six==1.15.0" > requirements.txt
printf '.venv/\n' > .gitignore
git add -A && git commit -qm init

node "$BW" six@1.17.0 --test "python3 -c 'import six'"

git rev-parse --verify -q bumpwright/six-1.17.0 >/dev/null || { echo "FAIL: branch missing"; exit 1; }
grep -q "six==1.17.0" requirements.txt || { echo "FAIL: requirements.txt not updated"; exit 1; }
git log -1 --pretty=%s | grep -q "Upgrade six 1.15.0 -> 1.17.0" || { echo "FAIL: bad commit message: $(git log -1 --pretty=%s)"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "FAIL: dirty tree"; exit 1; }
# Drifted venv: the installed version is AHEAD of the pin. The "from" version must come from
# requirements.txt (the manifest bumpwright writes), not from pip show, or a legitimate pin bump
# is reported as "Upgrade six 1.17.0 -> 1.16.0" — a downgrade, in a commit claiming an upgrade.
cd "$TMP" && rm -rf drift && mkdir drift && cd drift
git init -q -b main && git config user.email t@t && git config user.name t
python3 -m pip install --quiet --force-reinstall six==1.17.0
echo "six==1.15.0" > requirements.txt
git add -A && git commit -qm init

node "$BW" six@1.16.0 --test "python3 -c 'import six'"

git log -1 --pretty=%s | grep -q "Upgrade six 1.15.0 -> 1.16.0" || { echo "FAIL: 'from' version came from the venv, not requirements.txt: $(git log -1 --pretty=%s)"; exit 1; }
grep -q "six==1.16.0" requirements.txt || { echo "FAIL: requirements.txt not updated"; exit 1; }

echo "PYTHON OK"

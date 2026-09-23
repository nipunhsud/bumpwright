#!/usr/bin/env bash
# A failed upgrade leaves a paste-ready report; repair records the agent's reasoning.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# blocked upgrade -> BUMPWRIGHT-BLOCKED.md
mkdir "$TMP/blk" && cd "$TMP/blk"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"b","private":true,"dependencies":{"isarray":"1.0.0"},"scripts":{"test":"bash check.sh"} }' > package.json
cat > check.sh <<'CHK'
#!/usr/bin/env bash
v=$(node -p "require('isarray/package.json').version")
case "$v" in 1.*) exit 0;; esac
echo "SIGNATURE_MARKER: incompatible with isarray 2"
exit 1
CHK
printf '#!/usr/bin/env bash\ncat >/dev/null\n' > agent.sh && chmod +x agent.sh
printf 'node_modules/\nagent.sh\n' > .gitignore
npm install --silent >/dev/null 2>&1
git add -A && git commit -qm init
node "$BW" isarray@2.0.5 --agent ./agent.sh --max-iters 1 >/dev/null 2>&1 || true
[ -f BUMPWRIGHT-BLOCKED.md ] || { echo "FAIL: no blocked report"; exit 1; }
grep -q "Blocked upgrade: isarray" BUMPWRIGHT-BLOCKED.md || { echo "FAIL: bad report title"; exit 1; }
grep -q "SIGNATURE_MARKER" BUMPWRIGHT-BLOCKED.md || { echo "FAIL: failing output not captured"; exit 1; }
echo "BLOCKED REPORT OK"

# repair records the agent's explanation in the commit body
mkdir "$TMP/rat" && cd "$TMP/rat"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"r","private":true,"scripts":{"test":"bash check.sh"} }' > package.json
printf '#!/usr/bin/env bash\ngrep -q fixed broken.txt\n' > check.sh
echo broken > broken.txt
printf '#!/usr/bin/env bash\ncat >/dev/null\necho fixed > broken.txt\necho "ROOT CAUSE: the marker file said broken"\n' > agent.sh
chmod +x agent.sh
printf 'agent.sh\n' > .gitignore
git add -A && git commit -qm init
node "$BW" repair --agent ./agent.sh >/dev/null 2>&1
git log bumpwright/repair -1 --pretty=%B | grep -q "ROOT CAUSE: the marker file said broken" || { echo "FAIL: rationale not in commit"; exit 1; }
echo "REPAIR RATIONALE OK"

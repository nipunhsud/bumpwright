#!/usr/bin/env bash
# repair: red gate -> green, with anti-cheat guards.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 1. green gate -> nothing to repair
mkdir "$TMP/green" && cd "$TMP/green"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"g","private":true,"scripts":{"test":"exit 0"} }' > package.json
git add -A && git commit -qm init
node "$BW" repair | grep -q "already green" || { echo "FAIL: green gate not detected"; exit 1; }
[ -z "$(git branch --list 'bumpwright/*')" ] || { echo "FAIL: branch created for green gate"; exit 1; }

# 2. red gate -> agent fixes source -> commit
mkdir "$TMP/red" && cd "$TMP/red"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"r","private":true,"scripts":{"test":"bash check.sh"} }' > package.json
cat > check.sh <<'CHK'
#!/usr/bin/env bash
grep -q "fixed" broken.txt
CHK
echo "broken" > broken.txt
printf '#!/usr/bin/env bash\ncat >/dev/null\necho fixed > broken.txt\n' > agent.sh
chmod +x agent.sh
printf 'agent.sh\n' > .gitignore
git add -A && git commit -qm init
node "$BW" repair --agent ./agent.sh >/dev/null
git rev-parse --verify -q bumpwright/repair >/dev/null || { echo "FAIL: no repair branch"; exit 1; }
git show bumpwright/repair:broken.txt | grep -q fixed || { echo "FAIL: repair not committed"; exit 1; }
git log bumpwright/repair -1 --pretty=%s | grep -q "Repair:" || { echo "FAIL: bad commit subject"; exit 1; }

# 3. an agent that edits dependency manifests gets those reverted
mkdir "$TMP/deps" && cd "$TMP/deps"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"d","private":true,"dependencies":{"isarray":"1.0.0"},"scripts":{"test":"bash check.sh"} }' > package.json
cat > check.sh <<'CHK'
#!/usr/bin/env bash
grep -q "fixed" broken.txt
CHK
echo "broken" > broken.txt
cat > agent.sh <<'AG'
#!/usr/bin/env bash
cat >/dev/null
echo fixed > broken.txt
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.dependencies.isarray="2.0.5";fs.writeFileSync("package.json",JSON.stringify(p))'
AG
chmod +x agent.sh
printf 'agent.sh\n' > .gitignore
git add -A && git commit -qm init
OUT=$(node "$BW" repair --agent ./agent.sh 2>&1)
echo "$OUT" | grep -q "modified dependency manifests" || { echo "FAIL: dep edit not caught"; exit 1; }
git show bumpwright/repair:package.json | grep -q '"isarray":"1.0.0"' || { echo "FAIL: dep edit not reverted"; exit 1; }

# 4. test-file edits are flagged in output and commit
mkdir "$TMP/cheat" && cd "$TMP/cheat"
git init -q -b main && git config user.email t@t && git config user.name t
mkdir -p tests
printf '{ "name":"c","private":true,"scripts":{"test":"bash tests/check.sh"} }' > package.json
printf '#!/usr/bin/env bash\nexit 1\n' > tests/check.sh
printf '#!/usr/bin/env bash\ncat >/dev/null\nprintf "#!/usr/bin/env bash\\nexit 0\\n" > tests/check.sh\n' > agent.sh
chmod +x agent.sh
printf 'agent.sh\n' > .gitignore
git add -A && git commit -qm init
OUT=$(node "$BW" repair --agent ./agent.sh 2>&1)
echo "$OUT" | grep -q "test files changed" || { echo "FAIL: test-file edit not flagged"; exit 1; }
git log bumpwright/repair -1 --pretty=%B | grep -q "WARNING: test files were modified" || { echo "FAIL: warning missing from commit"; exit 1; }

echo "REPAIR OK"

# 5. a gate command containing backticks must not be executed by the commit path
mkdir "$TMP/inj" && cd "$TMP/inj"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"i","private":true }' > package.json
echo "broken" > broken.txt
printf '#!/usr/bin/env bash\ncat >/dev/null\necho fixed > broken.txt\n' > agent.sh
chmod +x agent.sh
printf 'agent.sh\n' > .gitignore
git add -A && git commit -qm init
node "$BW" repair --agent ./agent.sh --test 'grep -q fixed broken.txt && echo `id -un` >/dev/null' >/dev/null 2>&1 || true
git log bumpwright/repair -1 --pretty=%s 2>/dev/null | grep -q 'id -un' || { echo "FAIL: gate command not preserved literally in subject"; git log bumpwright/repair -1 --pretty=%s; exit 1; }
[ ! -f injected.txt ] || { echo "FAIL: command substitution executed"; exit 1; }
echo "REPAIR INJECTION OK"

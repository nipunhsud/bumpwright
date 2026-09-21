#!/usr/bin/env bash
# Go path: govulncheck-driven audit, go get bump, gate, commit.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
command -v go >/dev/null || { echo "SKIP: go not installed"; exit 0; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q -b main && git config user.email t@t && git config user.name t
cat > go.mod <<'MOD'
module bwfixture

go 1.21

require golang.org/x/text v0.3.5
MOD
cat > main.go <<'GO'
package main

import (
	"fmt"

	"golang.org/x/text/language"
)

func main() {
	t, _ := language.Parse("en")
	fmt.Println(t)
}
GO
go mod tidy >/dev/null 2>&1
git add -A && git commit -qm init
node "$BW" audit >/dev/null 2>&1 || { echo "FAIL: go audit run failed"; exit 1; }
BR=$(git branch --list 'bumpwright/golang.org-x-text-*' --format='%(refname:short)' | head -1)
[ -n "$BR" ] || { echo "FAIL: no go audit branch"; git branch -a; exit 1; }
git show "$BR:go.mod" | grep -q "golang.org/x/text v" || { echo "FAIL: x/text missing"; exit 1; }
git show "$BR:go.mod" | grep -q "x/text v0\.3\.[0-6]$" && { echo "FAIL: x/text still vulnerable"; exit 1; }
git log "$BR" -1 --pretty=%B | grep -q "pkg.go.dev/vuln/GO-" || { echo "FAIL: no Go advisory link"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "FAIL: dirty tree"; exit 1; }
echo "GO OK"

# --- module-level findings (vulnerable module required, code never called) are NOT targets ---
mkdir "$TMP/unreached" && cd "$TMP/unreached"
git init -q -b main && git config user.email t@t && git config user.name t
cat > go.mod <<'MOD'
module bwunreached

go 1.21

require golang.org/x/text v0.3.5
MOD
cat > main.go <<'GO'
package main

import (
	"fmt"

	"golang.org/x/text/width"
)

func main() { fmt.Println(width.Narrow.String()) }
GO
go mod tidy >/dev/null 2>&1
git add -A && git commit -qm init
OUT=$(node "$BW" audit 2>&1) || true
git branch --list 'bumpwright/*' | grep -q . && { echo "FAIL: branch created for an unreached vuln"; echo "$OUT" | tail -5; exit 1; }
echo "GO UNREACHED OK"

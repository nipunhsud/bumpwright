# bumpwright

**Upgrade a dependency, then fix the breaking changes — not just the version number.**

Dependabot and Renovate bump the version and hand you a red CI run. `bumpwright`
bumps the version, runs your tests, and when they break it drives a coding
agent to migrate your calling code until they pass again — then commits the
whole thing on a branch, optionally as a PR.

```
npx bumpwright react@19
```

What it does:

1. Checks your git tree is clean, creates `bumpwright/react-19`.
2. `npm install react@19`.
3. Runs your tests (`npm test` by default). Green? Commits, done.
4. Red? Feeds the failing output to a coding agent (Claude Code by default)
   with strict rules: adapt the calling code, never downgrade the package,
   never delete tests. Re-runs tests. Up to `--max-iters` times.
5. Green tests → one commit: the upgrade *and* the migration. `--pr` pushes
   and opens the PR via `gh`.

If the agent can't get to green, bumpwright exits non-zero and leaves the branch
in place with whatever progress was made. Your main branch is never touched.

## Install

```
npm install -g bumpwright     # or: npx bumpwright <pkg>
```

Requires Node 18+, git, and an agent CLI on your PATH
([Claude Code](https://claude.com/claude-code) by default).

## Usage

```
bumpwright <package>[@version] [options]

  --test <cmd>      Test command (default: npm test)
  --agent <cmd>     Agent command, receives the fix prompt on stdin
                    (default: claude -p --permission-mode acceptEdits)
  --max-iters <n>   Max fix attempts (default: 3)
  --pr              Push the branch and open a PR via gh
  --no-branch       Work on the current branch
  --workspaces      Also bump the package in every workspace subpackage that declares it
```

bumpwright also handles the parts that leave Dependabot PRs red or unopened:

- **Companion bumps.** If the install fails on a peer conflict (vite 8 wants a
  newer `@types/node` than you pin), bumpwright bumps the blocking companion
  alongside the target and retries, instead of dying like `npm install` does.
- **No test script?** If `package.json` has a build script but no real test
  script, the build becomes the red/green gate automatically.
- **pnpm and yarn** are detected from lockfiles, including from inside a
  workspace subpackage.

## Why not just ask Claude Code?

You can. Claude Code (or any coding agent) can do everything bumpwright does if
you prompt it carefully every time. bumpwright is the workflow, hardened:

- The guardrails are code, not prompt text: clean tree required, own branch,
  red tests never ship, one reviewable commit. An agent freelancing in your
  repo guarantees none of that.
- It's one command with zero prompt engineering, and the same command works
  headless in CI on a schedule — where nobody is typing prompts.
- It's agent-agnostic: swap Claude Code for Codex or anything else with
  `--agent` and the workflow doesn't change.

Any agent that reads a prompt on stdin and edits the working directory works:

```
bumpwright lodash --agent "claude -p --permission-mode acceptEdits"
bumpwright lodash --agent "codex exec --full-auto -"
```

## Python projects

The same loop works on Python. In a directory with `pyproject.toml` or
`requirements.txt` (and no `package.json`):

```
bumpwright requests@2.32.5 --test pytest
```

- `uv` projects: upgraded via `uv add` / `uv lock --upgrade-package` + `uv sync`
- pip projects: installed into the active environment and `requirements.txt`
  is rewritten to match, so the manifest stays truthful
- Default gate is `pytest`; pass `--test` for anything else
- Same guardrails: clean tree, green baseline required, own branch, red never ships

`bumpwright audit` works here too, via pip-audit.

## Go modules

In a directory with `go.mod` (and no `package.json`):

```
bumpwright golang.org/x/text@0.21.0 --test "go test ./..."
bumpwright audit
```

Audit is driven by **govulncheck**, Go's official scanner — it is call-graph
aware, so only vulnerabilities your code actually reaches become targets.
Fixes go through `go get module@fixed && go mod tidy`, which raises
transitive dependencies first-class — Go needs no overrides mechanism.
Default gate: `go test ./...`.

## Transitive vulnerabilities: `audit --overrides`

Findings buried in transitive deps can't be fixed by a direct bump — only an
override or an upstream release. Opt in and bumpwright pins each vulnerable
transitive to its patched floor (npm `overrides` / `pnpm.overrides`),
reinstalls, and runs your gate:

```
bumpwright audit --overrides [--pr]
```

Green → one commit, explicitly labeled **TEMPORARY**, listing every pin with
its advisory and the instruction to remove it once the parent updates. Red →
reverted, nothing ships. Off by default because overrides are debt — this
makes the debt visible, gated, and removable instead of silent.

## Scope: what actually ships

Audit labels findings that are only reachable through `devDependencies`:

```
→ 6 of 6 target(s) are dev/build tooling only (no consumer exposure)
```

A vulnerability in your bundler doesn't reach the people who install your
package. The label lands in the commit and PR body too, so reviewers can weigh
the fix instead of guessing at its urgency.

## When an upgrade can't be saved

If the agent can't get the gate green, bumpwright writes
`BUMPWRIGHT-BLOCKED.md`: what was attempted, the branch it left behind, and the
failing output — a report you can paste straight into an issue. A tool that
tells you exactly why you're stuck is worth nearly as much as one that unsticks
you.

## `bumpwright install` — when a fresh clone won't even install

```
bumpwright install
```

Walks the ladder for your package manager (`npm ci` → `npm install` →
`--legacy-peer-deps`, and the pnpm/yarn/berry equivalents) and reports which
rung worked. Needing anything past the first rung is itself a finding: a fresh
clone of that repo does not install with its own lockfile. Stale projects
usually fail here, long before any upgrade can be attempted.

## `bumpwright repair` — when the gate is already red

An upgrade needs a green baseline to prove anything, so bumpwright refuses to
start on a repo whose tests or build already fail. `repair` is the mode for
that state:

```
bumpwright repair [--test <cmd>] [--max-iters n] [--pr]
```

It drives an agent until the gate goes from red to green, on its own branch.
The success criterion is objective, and the agent is fenced in:

- the gate command is frozen, so success can't be redefined
- dependency manifests are reverted if touched — repair fixes code, not deps
- edits to test files are flagged in the console and in the commit message
- the agent is instructed to fix the root cause, never to skip or weaken tests

Review the diff before merging: a green gate proves the failure is gone, not
that the reasoning was right.

## `bumpwright fix` — the non-breaking half

```
bumpwright fix [--test <cmd>] [--pr]
```

Everything `npm audit fix` can do within your existing semver ranges, done
behind the guardrails: clean tree required, green baseline required, own
branch, and if the fixes break your gate they're reverted and nothing ships.
One commit clearing every mechanical vulnerability. The free audit service
runs this automatically and opens the PR.

## Security mode: `bumpwright audit`

The vulnerabilities nobody patches are the ones where the fix needs a breaking
upgrade — `npm audit fix` can't touch them and Dependabot's PR arrives red.

```
bumpwright audit --pr
```

Works across ecosystems: `npm audit` for npm repos, `pnpm audit` for pnpm
workspaces, `yarn audit` for classic yarn and `yarn npm audit` for yarn berry
(v2+, including PnP), `pip-audit` for Python, and `govulncheck` for Go. Direct
vulnerabilities get per-package branches; transitive ones are reported, or
pinned via overrides/resolutions with `--overrides`. Findings a plain
`npm audit fix` can handle are left to it; every fix that needs a real
version jump runs the full migrate loop on its own branch. Proposed
downgrades are skipped, and multiple advisories on one package resolve
to the highest patched version. The advisory URLs and severity land in the commit and PR body,
so the PR reads as the security fix it is. Exits non-zero if any upgrade
couldn't reach green.

Standing service on any repo — daily cron via the Action:

```yaml
      - uses: nipunhsud/bumpwright@v0.4.0
        with:
          package: audit             # security mode
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## GitHub Action (the Dependabot-replacement mode)

Dependabot opens red PRs on a schedule. This opens green ones:

```yaml
name: weekly-upgrades
on:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:
jobs:
  upgrade:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: nipunhsud/bumpwright@v0.4.0
        with:
          package: react@19          # or matrix over several packages
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
        env:
          GH_TOKEN: ${{ github.token }}
```

If the migration can't reach green, the job fails and nothing is opened —
you get silence instead of a red PR to babysit.

## Why

- Security patching and dependency maintenance is the #1 reported pain in the
  [2026 State of Open Source report](https://www.openlogic.com/blog/state-of-open-source-report-key-insights);
  55% of orgs that failed a compliance audit were running end-of-life packages
  they were afraid to upgrade.
- Version bumps are automated. Code migration isn't. That gap is where
  upgrades go to die in a `dependabot-ignore` list.

## Safety

- Refuses to run on a dirty working tree.
- Works on its own branch; your history is one `git branch -D` away from clean.
- The agent is instructed to never weaken or skip tests — but review the diff
  like any PR. It's a coding agent, not a notary.

## Related work

[Shridhar2104/bumpfix](https://github.com/marketplace/actions/bumpfix) applies
the same core idea — an agent fixing what a dependency bump broke, gated on
tests — as a CI-only action for Python manifests. Bumpwright is the npm-side
take, and adds initiation (you point it at an upgrade), `audit` security mode,
workspaces, companion bumps, an MCP server, and agent-agnostic drivers.

## License

MIT

## Free audit service

Don't want to install anything? [Open an issue](https://github.com/nipunhsud/bumpwright/issues/new?template=free-audit.yml)
naming a public repo you own. The service clones it, probes every vulnerability
whose fix needs a real version bump, and opens green upgrade PRs on your repo —
your own tests are the gate, red never ships. Findings that need actual
migration work come back as a report on the issue instead. Free, probe-mode
only (no AI edits), powered by GitHub Actions.

## Use with LLM coding tools

**Claude Code (or any agent with a shell):** no integration needed. Install
bumpwright on your PATH and add one line to your project's `CLAUDE.md`:

```
For dependency upgrades, run `bumpwright <pkg>@<version>` instead of hand-migrating.
```

**MCP (Claude Desktop, Cursor, and other no-shell clients):** bumpwright ships a
zero-dependency MCP stdio server exposing one tool, `upgrade_dependency`.

```
claude mcp add bumpwright -- bumpwright-mcp
```

Or in any MCP client config:

```json
{ "mcpServers": { "bumpwright": { "command": "bumpwright-mcp" } } }
```

The tool takes `package`, `cwd` (absolute project path), and optionally
`version`, `test`, `agent`, `max_iters`, `pr`. Same guardrails as the CLI:
clean tree required, own branch, red tests never ship.

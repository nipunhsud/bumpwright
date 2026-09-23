#!/usr/bin/env node
// bumpwright — upgrade a dependency, then fix the breaking changes, not just the version number.
// Zero dependencies. Node 18+.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HELP = `bumpwright <package>[@version] [options]
       bumpwright audit [options]      Fix every vulnerability that needs a breaking upgrade
       bumpwright fix [options]        Apply npm audit fix behind your test gate (non-breaking)
       bumpwright audit --overrides    Also pin vulnerable TRANSITIVE deps to patched floors (temporary, gated)
       bumpwright repair [options]     Gate already red? Drive an agent until it goes green (no deps touched)

Upgrades an npm dependency, runs your tests, and if they break, drives a
coding agent to migrate your calling code until they pass again.

Options:
  --test <cmd>      Test command (default: npm test)
  --agent <cmd>     Agent command, receives the fix prompt on stdin
                    (default: claude -p --permission-mode acceptEdits)
  --max-iters <n>   Max fix attempts (default: 3)
  --workspaces      Also bump the package in every workspace subpackage that declares it
  --pr              Push the branch and open a PR via gh
  --no-branch       Work on the current branch instead of bumpwright/<pkg>
  -h, --help        Show this help
`;

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", ...opts });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function die(msg) { console.error(`bumpwright: ${msg}`); process.exit(1); }

function commit(message) {
  // message goes in on stdin: no shell, so backticks/$() in a gate command
  // or filename can never be executed.
  const r = spawnSync("git", ["commit", "-F", "-"], { input: message, encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function need(val, flag) {
  if (val === undefined || String(val).startsWith("--")) die(`${flag} needs a value`);
  return val;
}

function parseArgs(argv) {
  const pm = isPython() ? { install: "(py)", test: "pytest", sync: pyUsesUv() ? "uv sync" : (fs.existsSync("requirements.txt") ? "python3 -m pip install -r requirements.txt" : "true"), py: true }
    : isGo() ? { install: "(go)", test: "go test ./...", sync: "true", go: true }
    : detectPm();
  const a = { pm, test: pm.test, agent: "claude -p --permission-mode acceptEdits", maxIters: 3, pr: false, branch: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--test") { a.test = need(argv[++i], "--test"); a.testExplicit = true; }
    else if (v === "--workspaces") a.workspaces = true;
    else if (v === "--agent") a.agent = need(argv[++i], "--agent");
    else if (v === "--max-iters") { const n = parseInt(need(argv[++i], "--max-iters"), 10); a.maxIters = Number.isNaN(n) || n < 0 ? 3 : n; }
    else if (v === "--pr") a.pr = true;
    else if (v === "--no-branch") a.branch = false;
    else if (v === "-h" || v === "--help") { console.log(HELP); process.exit(0); }
    else rest.push(v);
  }
  if (rest.length !== 1) { console.log(HELP); process.exit(rest.length ? 1 : 0); }
  const at = rest[0].lastIndexOf("@");
  a.pkg = at > 0 ? rest[0].slice(0, at) : rest[0];
  a.version = at > 0 ? rest[0].slice(at + 1) : "latest";
  if (isGo()) {
    if (!/^[A-Za-z0-9._~\/-]+$/.test(a.pkg)) die(`invalid module path: ${a.pkg}`);
  } else if (!/^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i.test(a.pkg)) die(`invalid package name: ${a.pkg}`);
  if (!/^[\w.^~<>=*|+ -]+$/.test(a.version)) die(`invalid version spec: ${a.version}`);
  return a;
}

function isPython() {
  return !fs.existsSync("package.json") && (fs.existsSync("pyproject.toml") || fs.existsSync("requirements.txt"));
}
function pyUsesUv() { return fs.existsSync("uv.lock") || (fs.existsSync("pyproject.toml") && run("command -v uv").code === 0); }
function pyCurrentVersion(pkg) {
  const show = run(pyUsesUv() ? `uv pip show "${pkg}"` : `python3 -m pip show "${pkg}"`);
  const m = show.out.match(/^Version: (.+)$/m);
  return m ? m[1].trim() : null;
}
function pyInstallCmd(pkg, version) {
  if (pyUsesUv())
    return version === "latest" ? `uv lock --upgrade-package "${pkg}" && uv sync` : `uv add "${pkg}==${version}"`;
  const spec = version === "latest" ? `-U "${pkg}"` : `"${pkg}==${version}"`;
  return `python3 -m pip install ${spec}`;
}
function pyRecordRequirement(pkg, newVersion) {
  // pip has no manifest write; keep requirements.txt truthful ourselves.
  if (!fs.existsSync("requirements.txt")) return;
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}\\s*[=<>~!].*$`, "mi");
  const txt = fs.readFileSync("requirements.txt", "utf8");
  if (re.test(txt)) fs.writeFileSync("requirements.txt", txt.replace(re, `${pkg}==${newVersion}`));
}

function isGo() {
  return !fs.existsSync("package.json") && !isPython() && fs.existsSync("go.mod");
}
function goCurrentVersion(mod) {
  const r = run(`go list -m "${mod}"`);
  const m = r.out.trim().split(/\s+/);
  return r.code === 0 && m[1] ? m[1] : null;
}
function goVersionSpec(v) { return v === "latest" ? "latest" : (/^\d/.test(v) ? `v${v}` : v); }

function isYarnBerry() {
  if (!fs.existsSync("yarn.lock")) return false;
  if (fs.existsSync(".yarnrc.yml")) return true;
  try { return /^__metadata:/m.test(fs.readFileSync("yarn.lock", "utf8").slice(0, 4000)); } catch { return false; }
}

function detectPm() {
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, "pnpm-lock.yaml")))
      return { install: d === process.cwd() && fs.existsSync(path.join(d, "pnpm-workspace.yaml")) ? "pnpm add -w" : "pnpm add", test: "pnpm test", sync: "pnpm install --frozen-lockfile" };
    if (fs.existsSync(path.join(d, "yarn.lock")))
      return d === process.cwd() && isYarnBerry()
        ? { install: "yarn add", test: "yarn test", sync: "yarn install --immutable" }
        : { install: "yarn add", test: "yarn test", sync: "yarn install --frozen-lockfile" };
    if (fs.existsSync(path.join(d, "package-lock.json"))) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { install: "npm install", test: "npm test", sync: "npm ci" };
}

function currentVersion(pkg, dir = ".") {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    for (const k of ["dependencies", "devDependencies", "optionalDependencies"])
      if (pj[k] && pj[k][pkg]) return pj[k][pkg];
  } catch { /* fall through */ }
  return null;
}

function workspaceDirs(pkg) {
  const dirs = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const sub = path.join(d, e.name);
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(sub, "package.json"), "utf8"));
        if ((pj.dependencies && pj.dependencies[pkg]) || (pj.devDependencies && pj.devDependencies[pkg]))
          dirs.push(sub);
      } catch { /* no or bad package.json */ }
      walk(sub, depth + 1);
    }
  })(".", 1);
  if (currentVersion(pkg)) dirs.unshift(".");
  return dirs.length ? dirs : ["."];
}

function vtuple(v) { return String(v).replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0); }
function isDowngrade(fix, cur) {
  const [a, b] = [vtuple(fix), vtuple(cur)];
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); }
  return false;
}
function installedVersion(name) {
  try { return JSON.parse(fs.readFileSync(path.join("node_modules", name, "package.json"), "utf8")).version; }
  catch { return null; }
}
function addTx(counts, name, version, advisories) {
  counts.txTargets = counts.txTargets || new Map();
  const e = counts.txTargets.get(name) || { version, advisories: [] };
  if (isDowngrade(e.version, version)) e.version = version;
  e.advisories.push(...advisories);
  counts.txTargets.set(name, e);
}

function addTarget(majors, name, version, severity, advisories, counts) {
  const cur = installedVersion(name);
  if (cur && isDowngrade(version, cur)) {
    counts.skipped = counts.skipped || new Set();
    // several advisories can name the same package; say it once
    const line = `→ skipping ${name}: proposed fix is a downgrade (${cur} -> ${version}) — no real fix published yet`;
    if (!counts.skipped.has(line)) { console.log(line); counts.skipped.add(line); }
    counts.downgrades++;
    return;
  }
  const entry = majors.get(name) || { version, severity, advisories: [] };
  if (isDowngrade(entry.version, version)) entry.version = version; // several advisories: take the highest patched version
  entry.advisories.push(...advisories);
  majors.set(name, entry);
}

function collectNpmAudit(counts) {
  console.log("→ npm audit --json");
  const audit = run("npm audit --json");
  let report;
  try { report = JSON.parse(audit.out.slice(audit.out.indexOf("{"), audit.out.lastIndexOf("}") + 1)); }
  catch {
    die(/lock/i.test(audit.out)
      ? "npm audit needs a package-lock.json — run `npm install` first"
      : "could not parse npm audit output");
  }
  const vulns = report.vulnerabilities || {};
  const advisoriesOf = (v, depth = 0) => {
    if (!v || depth > 2) return [];
    return (v.via || []).flatMap((x) =>
      typeof x === "object" ? [x.url || x.title].filter(Boolean) : advisoriesOf(vulns[x], depth + 1));
  };
  const majors = new Map();
  for (const v of Object.values(vulns)) {
    const f = v.fixAvailable;
    if (!f) {
      // no computed fix: candidate for a transitive override at the patched floor
      const uppers = (v.via || []).filter((x) => typeof x === "object")
        .flatMap((x) => [...String(x.range || "").matchAll(/<\s*([\d.]+)/g)].map((m) => m[1]));
      if (uppers.length) addTx(counts, v.name, uppers.sort((a, b) => (isDowngrade(a, b) ? -1 : 1)).pop(), (v.via || []).filter((x) => typeof x === "object").map((x) => x.url).filter(Boolean));
      counts.transitive++;
      continue;
    }
    if (f === true || !f.isSemVerMajor) { counts.fixable++; continue; }
    addTarget(majors, f.name, f.version, v.severity, advisoriesOf(v), counts);
  }
  if (counts.fixable) console.log(`→ ${counts.fixable} finding(s) fixable without a major bump — \`bumpwright fix\` applies them behind your test gate`);
  return majors;
}

function directDepDirs() {
  const map = new Map();
  const record = (dir) => {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      for (const k of ["dependencies", "devDependencies"])
        for (const [name, spec] of Object.entries(pj[k] || {}))
          if (!map.has(name)) map.set(name, { dir, spec });
    } catch { /* no manifest */ }
  };
  record(".");
  (function walk(d, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, "package.json"))) record(sub);
      walk(sub, depth + 1);
    }
  })(".", 1);
  return map;
}

function collectPnpmAudit(counts) {
  console.log("→ pnpm audit --json");
  const audit = run("pnpm audit --json");
  let report;
  try { report = JSON.parse(audit.out.slice(audit.out.indexOf("{"), audit.out.lastIndexOf("}") + 1)); } catch { die("could not parse pnpm audit output"); }
  const direct = directDepDirs(); // any workspace manifest counts as direct
  const majors = new Map();
  for (const adv of Object.values(report.advisories || {})) {
    const name = adv.module_name;
    if (!direct.has(name)) {
      const fl = [...String(adv.patched_versions || "").matchAll(/>=\s*([\d.]+)/g)].map((x) => x[1]);
      if (fl.length) addTx(counts, name, fl.sort((a, b) => (isDowngrade(a, b) ? -1 : 1)).pop(), [adv.url].filter(Boolean));
      counts.transitive++;
      continue;
    }
    const spec = String(direct.get(name).spec || "");
    if (/^(workspace|file|link|portal|git|github):/.test(spec)) {
      // an internal workspace link or non-registry dep — only an upstream release fixes this
      console.log(`→ skipping ${name}: ${spec.split(":")[0]}: specifier, not a registry dependency`);
      counts.transitive++;
      continue;
    }
    // Ranges like ">=0.2.4 <1.0.0 || >=1.2.3" patch several lines; target the highest floor.
    const floors = [...String(adv.patched_versions || "").matchAll(/>=\s*([\d.]+)/g)].map((x) => x[1]);
    const m = floors.length ? [null, floors.sort((a, b) => (isDowngrade(a, b) ? -1 : 1)).pop()] : null;
    if (!m) { counts.transitive++; continue; }
    // an advisory can list several installed instances; guard against the HIGHEST,
    // or a fix for an old copy masquerades as an upgrade (Trilium: pdfjs-dist 6.3->6.2)
    const found = (adv.findings || []).map((x) => x.version).filter(Boolean)
      .sort((a, b) => (isDowngrade(a, b) ? -1 : 1));
    const cur = found.pop() || installedVersion(name);
    if (cur && isDowngrade(m[1], cur)) { counts.downgrades++; continue; }
    addTarget(majors, name, m[1], adv.severity || "security", [adv.url].filter(Boolean), counts);
    const entry = majors.get(name);
    if (entry) entry.dir = direct.get(name).dir;
  }
  if (counts.transitive) console.log(`→ ${counts.transitive} finding(s) in transitive deps — out of scope for a direct bump (overrides or upstream)`);
  return majors;
}

function collectYarnBerryAudit(counts) {
  console.log("→ yarn npm audit --json --recursive");
  const audit = run("yarn npm audit --json --recursive --all");
  const majors = new Map();
  let lines = 0;
  for (const line of audit.out.split("\n")) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const c = o && o.children;
    if (!o || !o.value || !c) continue;
    lines++;
    const name = o.value;
    // "Vulnerable Versions" like "<0.2.4" or ">=1.0.0 <1.2.3": the upper bounds are the patched floors
    const floors = [...String(c["Vulnerable Versions"] || "").matchAll(/<\s*=?\s*([\d][\w.-]*)/g)].map((x) => x[1]);
    if (!floors.length) { counts.transitive++; continue; }
    const floor = floors.sort((a, b) => (isDowngrade(a, b) ? -1 : 1)).pop();
    const installed = (c["Tree Versions"] || []).slice().sort((a, b) => (isDowngrade(a, b) ? -1 : 1)).pop();
    if (installed && isDowngrade(floor, installed)) { counts.downgrades++; continue; }
    const direct = (c.Dependents || []).some((d) => /@workspace:/.test(d));
    const url = c.URL ? [c.URL] : [];
    if (direct) addTarget(majors, name, floor, String(c.Severity || "security"), url, counts);
    else { addTx(counts, name, floor, url); counts.transitive++; }
  }
  if (!lines && audit.code !== 0) { console.error(audit.out.slice(-1200)); die("yarn npm audit produced no advisories — the scan did not run"); }
  if (counts.transitive) console.log(`→ ${counts.transitive} finding(s) in transitive deps — out of scope for a direct bump (resolutions or upstream)`);
  return majors;
}

function collectYarnAudit(counts) {
  console.log("→ yarn audit --json");
  const audit = run("yarn audit --json");
  const majors = new Map();
  const seenDirect = new Set();
  for (const line of audit.out.split("\n")) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (!msg || msg.type !== "auditAdvisory") continue;
    const a = msg.data && msg.data.advisory;
    if (!a) continue;
    const name = a.module_name;
    const floors = [...String(a.patched_versions || "").matchAll(/>=\s*([\d.]+)/g)].map((x) => x[1]);
    if (!floors.length) { counts.transitive++; continue; }
    const floor = floors.sort((x, y) => (isDowngrade(x, y) ? -1 : 1)).pop();
    const findings = a.findings || [];
    const direct = findings.some((f) => (f.paths || []).some((pth) => pth === name));
    const cur = findings.flatMap((f) => [f.version]).filter(Boolean)
      .sort((x, y) => (isDowngrade(x, y) ? -1 : 1)).pop() || installedVersion(name);
    if (cur && isDowngrade(floor, cur)) { counts.downgrades++; continue; }
    if (direct) {
      addTarget(majors, name, floor, a.severity || "security", [a.url].filter(Boolean), counts);
      seenDirect.add(name);
    } else if (!seenDirect.has(name)) {
      addTx(counts, name, floor, [a.url].filter(Boolean));
      counts.transitive++;
    }
  }
  return majors;
}

function jsonStream(text) {
  // govulncheck -json emits a stream of pretty-printed JSON objects
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (!depth) start = i; depth++; }
    else if (c === "}") { depth--; if (!depth && start >= 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* partial */ } start = -1; } }
  }
  return out;
}

function collectGoAudit(counts) {
  const haveBin = run("command -v govulncheck").code === 0;
  const tool = haveBin ? "govulncheck" : "go run golang.org/x/vuln/cmd/govulncheck@latest";
  if (!haveBin) console.log("→ govulncheck not installed; fetching it via `go run` (slower)");
  console.log(`→ ${tool} -json ./...`);
  const audit = run(`${tool} -json ./...`);
  const objs = jsonStream(audit.out);
  // An empty scan is not a clean scan: treat "no output at all" as a failure,
  // never as "no vulnerabilities".
  if (!objs.length) {
    console.error(audit.out.slice(-1500));
    die("govulncheck produced no output — the scan did not run (timeout, fetch failure, or build error). This is not a clean result.");
  }
  const majors = new Map();
  for (const o of objs) {
    const f = o.finding;
    if (!f || !f.fixed_version || !f.trace || !f.trace.length) continue;
    const t0 = f.trace[0];
    const mod = t0.module;
    if (!mod) continue;
    // govulncheck emits module-, package-, and symbol-level findings. Only a
    // symbol-level finding (trace[0].function set) means the vulnerable code is
    // actually called. The rest are "present but not reached" — not a target.
    if (!t0.function) { counts.unreached = (counts.unreached || 0) + 1; continue; }
    const cur = t0.version;
    if (cur && isDowngrade(f.fixed_version, cur)) { counts.downgrades++; continue; }
    // Go get raises transitive deps first-class — every reachable finding is a target
    addTarget(majors, mod, f.fixed_version, "security", [`https://pkg.go.dev/vuln/${f.osv}`], counts);
  }
  if (counts.unreached) console.log(`→ ${counts.unreached} finding(s) in imported modules whose vulnerable code is never called — not targeted`);
  console.log(`→ ${majors.size} reachable vulnerable module(s) with a fixed version (symbol-level govulncheck findings)`);
  return majors;
}

function collectPyAudit(counts) {
  const tool = run("command -v pip-audit").code === 0 ? "pip-audit" : "uvx pip-audit";
  // Audit the project's own requirements, not whichever environment pip-audit runs in.
  let src = "";
  if (fs.existsSync("requirements.txt")) src = "-r requirements.txt";
  else if (pyUsesUv()) {
    const tmp = path.join(process.env.TMPDIR || "/tmp", `bw-req-${process.pid}.txt`);
    if (run(`uv export --format requirements-txt --no-emit-project -o "${tmp}"`).code === 0) src = `-r "${tmp}"`;
  }
  if (!src) die("nothing to audit against: add requirements.txt or a uv lockfile — auditing an unrelated environment would report the wrong repo");
  console.log(`→ ${tool} -f json ${src}`.trim());
  const audit = run(`${tool} -f json ${src}`);
  let report;
  try { report = JSON.parse(audit.out.slice(audit.out.indexOf("{"), audit.out.lastIndexOf("}") + 1)); } catch { die("could not parse pip-audit output — is pip-audit installed?"); }
  const direct = new Set();
  if (fs.existsSync("requirements.txt"))
    for (const line of fs.readFileSync("requirements.txt", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)/); if (m) direct.add(m[1].toLowerCase());
    }
  if (fs.existsSync("pyproject.toml"))
    for (const m of fs.readFileSync("pyproject.toml", "utf8").matchAll(/^\s*"([A-Za-z0-9_.-]+)[=<>~!;\[" ]/gm))
      direct.add(m[1].toLowerCase()); // ponytail: regex over quoted strings, close enough for dependency arrays
  const majors = new Map();
  for (const dep of report.dependencies || []) {
    const vulns = (dep.vulns || []).filter((v) => (v.fix_versions || []).length);
    if (!vulns.length) continue;
    if (direct.size && !direct.has(dep.name.toLowerCase())) { counts.transitive++; continue; }
    const fixes = vulns.flatMap((v) => v.fix_versions);
    const target = fixes.sort((a, b) => (isDowngrade(a, b) ? -1 : 1)).pop();
    if (isDowngrade(target, dep.version)) { counts.downgrades++; continue; }
    const urls = vulns.map((v) => `https://osv.dev/vulnerability/${v.id}`);
    addTarget(majors, dep.name, target, "security", urls, counts);
  }
  if (counts.transitive) console.log(`→ ${counts.transitive} vulnerable transitive/unlisted package(s) — out of scope for a direct bump`);
  return majors;
}

function repairMode(argv) {
  const a = { test: null, agent: "claude -p --permission-mode acceptEdits", maxIters: 3, branch: true, pr: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--test") a.test = need(argv[++i], "--test");
    else if (v === "--agent") a.agent = need(argv[++i], "--agent");
    else if (v === "--max-iters") { const n = parseInt(need(argv[++i], "--max-iters"), 10); a.maxIters = Number.isNaN(n) || n < 1 ? 3 : n; }
    else if (v === "--no-branch") a.branch = false;
    else if (v === "--pr") a.pr = true;
    else die(`unrecognized argument: ${v}`);
  }
  if (run("git rev-parse --is-inside-work-tree").code !== 0) die("not a git repository");
  const dirty = run("git status --porcelain").out.split("\n").filter((l) => l.trim() && !l.startsWith("??"));
  if (dirty.length) die("tracked files modified — commit or stash first");

  if (!a.test) {
    const pm = isPython() ? { test: "pytest" } : isGo() ? { test: "go test ./..." } : detectPm();
    a.test = pm.test;
    if (!isPython() && !isGo() && fs.existsSync("package.json")) {
      const pj = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const t = pj.scripts && pj.scripts.test;
      if ((!t || /no test specified/i.test(t)) && pj.scripts && pj.scripts.build) a.test = `${a.test.split(" ")[0]} run build`;
      else if (t && /react-scripts test/.test(t)) a.test = "CI=true npm test -- --watchAll=false";
    }
  }

  console.log(`→ gate: ${a.test}`);
  const before = run(a.test);
  if (before.code === 0) { console.log("✓ gate is already green — nothing to repair"); process.exit(0); }

  const startRef = run("git rev-parse HEAD").out.trim();
  if (a.branch) {
    if (run("git checkout -b bumpwright/repair").code !== 0) die("could not create branch bumpwright/repair (already exists?)");
    console.log("→ branch bumpwright/repair");
  }

  // Files the agent must not "fix" by deleting the evidence.
  const testish = (f) => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|_test\.go$|test_.*\.py$/i.test(f);

  let out = before.out, result = before;
  for (let i = 1; i <= a.maxIters; i++) {
    console.log(`✗ gate red — repair attempt ${i}/${a.maxIters}`);
    const prompt = `The command \`${a.test}\` fails in this repository, on a clean checkout, before any dependency change.

Diagnose the root cause and fix it so the command passes.

Rules:
- Do NOT change, skip, weaken, or delete tests to make this pass. Fix the code or configuration that is actually broken.
- Do NOT change the command itself, and do not add flags that hide the failure.
- Do NOT upgrade, downgrade, add, or remove dependencies. This is a repair of existing code, not a dependency change.
- Keep the diff minimal and explain the root cause in your final message.

Failing output:
${result.out.slice(-8000)}`;
    const agent = spawnSync(a.agent, { shell: true, input: prompt, stdio: ["pipe", "inherit", "inherit"] });
    if ((agent.status ?? 1) !== 0) console.error("bumpwright: agent command exited non-zero, re-running the gate anyway");

    const depsTouched = run(`git diff --name-only "${startRef}"`).out.split("\n")
      .filter((f) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|requirements\.txt|pyproject\.toml)$/.test(f.trim()));
    if (depsTouched.length) {
      console.error(`bumpwright: agent modified dependency manifests (${depsTouched.join(", ")}) — reverting those, repair must not change deps`);
      for (const f of depsTouched) run(`git checkout "${startRef}" -- "${f}"`);
    }

    console.log(`→ ${a.test}`);
    result = run(a.test);
    out = result.out;
    if (result.code === 0) break;
    if (i === a.maxIters) {
      console.error(out.slice(-3000));
      console.error(`\nbumpwright: gate still red after ${a.maxIters} repair attempts.`);
      console.error(a.branch ? "Branch bumpwright/repair left in place for manual work." : "Changes left in working tree.");
      process.exit(1);
    }
  }

  const changed = run(`git diff --name-only "${startRef}"`).out.split("\n").map((f) => f.trim()).filter(Boolean);
  const touchedTests = changed.filter(testish);
  console.log("✓ gate green");
  if (touchedTests.length) console.log(`⚠ test files changed — review these closely: ${touchedTests.join(", ")}`);
  run("git add -A");
  const msg = `Repair: make "${a.test}" pass again\n\n` +
    `The gate was failing on a clean checkout before any dependency change.\n` +
    `Files changed: ${changed.join(", ")}\n` +
    (touchedTests.length ? `\nWARNING: test files were modified (${touchedTests.join(", ")}) — verify the fix is real.\n` : "") +
    `\nAutomated by bumpwright repair; review before merging.`;
  if (commit(msg).code !== 0) die("git commit failed");
  console.log("✓ committed repair");
  if (a.pr) {
    if (run("git push -u origin bumpwright/repair").code !== 0) die("git push failed");
    if (run("gh pr create --fill", { stdio: ["ignore", "inherit", "inherit"], encoding: undefined }).code !== 0) die("gh pr create failed");
  }
  process.exit(0);
}

function fixMode(argv) {
  if (!fs.existsSync("package.json")) die("no package.json here — run from your project root");
  if (fs.existsSync("pnpm-lock.yaml") || fs.existsSync("yarn.lock"))
    die("`fix` is npm-only — for pnpm/yarn run `bumpwright audit` (direct vulns get per-package branches; add --overrides for transitive)");
  const a = { test: "npm test", branch: true, pr: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--test") a.test = need(argv[++i], "--test");
    else if (v === "--no-branch") a.branch = false;
    else if (v === "--pr") a.pr = true;
  }
  if (run("git rev-parse --is-inside-work-tree").code !== 0) die("not a git repository");
  // fix only ever touches the manifests, so untracked files (someone's WIP) are fine.
  const dirty = run("git status --porcelain").out.split("\n").filter((l) => l.trim() && !l.startsWith("??"));
  if (dirty.length) die("tracked files modified — commit or stash first");
  const pj = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const t = pj.scripts && pj.scripts.test;
  if (a.test === "npm test" && (!t || /no test specified/i.test(t)) && pj.scripts && pj.scripts.build) {
    a.test = "npm run build";
    console.log(`→ no test script; using the build as the gate: ${a.test}`);
  }
  if (a.test === "npm test" && t && /react-scripts test/.test(t)) {
    a.test = "CI=true npm test -- --watchAll=false";
    console.log(`→ react-scripts detected; using CI-safe gate: ${a.test}`);
  }
  console.log(`→ baseline: ${a.test}`);
  const base = run(a.test);
  if (base.code !== 0) { console.error(base.out.slice(-2000)); die(`the gate "${a.test}" is already red — run \`bumpwright repair\` first, or pass a working --test`); }
  if (a.branch) {
    if (run("git checkout -b bumpwright/audit-fix").code !== 0) die("could not create branch bumpwright/audit-fix (already exists?)");
    console.log("→ branch bumpwright/audit-fix");
  }
  console.log("→ npm audit fix");
  run("npm audit fix");
  if (run("git status --porcelain").out.trim() === "") {
    console.log("✓ nothing npm audit fix could safely change");
    process.exit(0);
  }
  console.log(`→ ${a.test}`);
  const after = run(a.test);
  if (after.code !== 0) {
    console.error(after.out.slice(-3000));
    run("git checkout -- .");
    die("npm audit fix broke the gate — reverted, nothing shipped");
  }
  for (const f of ["package.json", "package-lock.json", "npm-shrinkwrap.json"])
    if (fs.existsSync(f)) run(`git add -- "${f}"`);
  const msg = "Apply npm audit fix (non-breaking security updates)\n\nAll changes stay within existing semver ranges; the test gate ran green.\n\nAutomated by bumpwright.";
  if (commit(msg).code !== 0) die("git commit failed");
  console.log("✓ committed npm audit fix behind a green gate");
  if (a.pr) {
    if (run("git push -u origin bumpwright/audit-fix").code !== 0) die("git push failed");
    const pr = run("gh pr create --fill", { stdio: ["ignore", "inherit", "inherit"], encoding: undefined });
    if (pr.code !== 0) die("gh pr create failed");
  }
  process.exit(0);
}

function auditMode(argv) {
  if (!fs.existsSync("package.json") && !isPython() && !isGo()) die("no package.json, pyproject.toml/requirements.txt, or go.mod here — run from your project root");
  const passthrough = [], stray = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (["--test", "--agent", "--max-iters"].includes(v)) passthrough.push(v, need(argv[++i], v));
    else if (["--pr", "--no-branch", "--workspaces"].includes(v)) passthrough.push(v);
    else if (v === "--overrides") { /* consumed below */ }
    else stray.push(v);
  }
  if (stray.length)
    die(`unrecognized argument(s): ${stray.join(" ")}\n` +
        `       a multi-word --agent command must be quoted, e.g. --agent "claude -p --permission-mode acceptEdits"`);
  let useOverrides = false;
  const oi = argv.indexOf("--overrides");
  if (oi >= 0) { useOverrides = true; argv.splice(oi, 1); }
  const counts = { fixable: 0, downgrades: 0, transitive: 0 };
  let majors, sync;
  if (isPython()) {
    majors = collectPyAudit(counts);
    sync = pyUsesUv() ? "uv sync" : (fs.existsSync("requirements.txt") ? "python3 -m pip install -r requirements.txt" : "true");
  } else if (fs.existsSync("pnpm-lock.yaml")) {
    majors = collectPnpmAudit(counts);
    sync = "pnpm install --frozen-lockfile";
  } else if (fs.existsSync("yarn.lock")) {
    const berry = isYarnBerry();
    majors = berry ? collectYarnBerryAudit(counts) : collectYarnAudit(counts);
    sync = berry ? "yarn install --immutable" : "yarn install --frozen-lockfile";
  } else if (isGo()) {
    majors = collectGoAudit(counts);
    sync = "true"; // the module cache is content-addressed; restoring go.mod/go.sum restores everything
  } else {
    majors = collectNpmAudit(counts);
    sync = detectPm().sync;
  }
  if (counts.downgrades) console.log(`→ ${counts.downgrades} proposed fix(es) skipped as downgrades`);
  const txT = (useOverrides && counts.txTargets) || new Map();
  if (counts.transitive && !useOverrides && !isPython())
    console.log("→ re-run with --overrides to pin transitive patched floors behind your gate (temporary, removable)");
  if (!majors.size && !txT.size) { console.log("✓ no vulnerabilities need a breaking upgrade"); process.exit(0); }
  const start = run("git rev-parse --abbrev-ref HEAD").out.trim();
  let failed = 0;
  for (const [name, info] of majors) {
    console.log(`\n=== ${name}@${info.version} — security (${info.severity}) ===`);
    const urls = [...new Set(info.advisories)];
    const env = { ...process.env, BUMPWRIGHT_NOTE: urls.length ? `Security: fixes ${urls.join(", ")}` : `Security: fixes audit finding (${info.severity})` };
    if (info.dir && info.dir !== ".") console.log(`→ in workspace ${info.dir}`);
    const r = spawnSync(process.execPath, [__filename, `${name}@${info.version}`, ...passthrough], { stdio: "inherit", env, cwd: info.dir || "." });
    if ((r.status ?? 1) !== 0) failed++;
    run(`git checkout -f "${start}"`);
    run("git checkout -- .");
    console.log("→ resyncing installed packages to the lockfile");
    run(sync);
  }
  if (txT.size) {
    const isPnpm = fs.existsSync("pnpm-lock.yaml");
    const isYarn = !isPnpm && fs.existsSync("yarn.lock");
    const pmName = isPnpm ? "pnpm" : isYarn ? "yarn" : "npm";
    console.log(`\n=== security overrides for ${txT.size} transitive dep(s) ===`);
    let testCmd = null;
    const ti = argv.indexOf("--test");
    if (ti >= 0) testCmd = argv[ti + 1];
    if (!testCmd) {
      const pj0 = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const t0 = pj0.scripts && pj0.scripts.test;
      testCmd = (!t0 || /no test specified/i.test(t0)) && pj0.scripts && pj0.scripts.build
        ? `${pmName} run build` : `${pmName} test`;
    }
    console.log(`→ baseline: ${testCmd}`);
    const base = run(testCmd);
    if (base.code !== 0) { console.error(base.out.slice(-1500)); console.error("bumpwright: gate already red — overrides not attempted"); failed++; }
    else if (run("git checkout -b bumpwright/security-overrides").code !== 0) { console.error("bumpwright: branch bumpwright/security-overrides already exists"); failed++; }
    else {
      const pj = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const dest = isPnpm ? ((pj.pnpm = pj.pnpm || {}), (pj.pnpm.overrides = pj.pnpm.overrides || {}), pj.pnpm.overrides)
        : isYarn ? (pj.resolutions = pj.resolutions || {})
        : (pj.overrides = pj.overrides || {});
      const lines = [];
      for (const [n, info] of txT) { dest[n] = `^${info.version}`; lines.push(`- ${n} -> ^${info.version} (${[...new Set(info.advisories)].join(", ") || "audit finding"})`); }
      fs.writeFileSync("package.json", JSON.stringify(pj, null, 2) + "\n");
      const inst = run(isPnpm ? "pnpm install" : isYarn ? "yarn install" : "npm install");
      const after = inst.code === 0 ? run(testCmd) : inst;
      if (after.code !== 0) {
        console.error(after.out.slice(-2500));
        run(`git checkout -f "${start}"`); run("git checkout -- ."); run(sync);
        console.error("bumpwright: overrides broke the gate — reverted, nothing shipped");
        failed++;
      } else {
        run("git add -A");
        const msg = `Security overrides (TEMPORARY) for vulnerable transitive deps\n\n${lines.join("\n")}\n\nThese pins force patched versions that the direct parents do not yet require. Remove each override once its parent updates. Gate '${testCmd}' ran green with the pins applied.\n\nAutomated by bumpwright.`;
        if (commit(msg).code !== 0) { console.error("bumpwright: commit failed"); failed++; }
        else {
          console.log(`✓ committed ${txT.size} security override(s) behind a green gate`);
          if (argv.includes("--pr")) {
            if (run("git push -u origin bumpwright/security-overrides").code !== 0) { console.error("bumpwright: push failed"); failed++; }
            else if (run("gh pr create --fill", { stdio: ["ignore", "inherit", "inherit"], encoding: undefined }).code !== 0) { console.error("bumpwright: gh pr create failed"); failed++; }
          }
        }
      }
    }
  }
  const total = majors.size + (txT.size ? 1 : 0);
  console.log(failed ? `\n✗ ${failed}/${total} security upgrades did not reach green` : `\n✓ all ${total} security upgrades green`);
  process.exit(failed ? 1 : 0);
}

function main() {
  if (process.argv[2] === "audit") return auditMode(process.argv.slice(3));
  if (process.argv[2] === "fix") return fixMode(process.argv.slice(3));
  if (process.argv[2] === "repair") return repairMode(process.argv.slice(3));
  const a = parseArgs(process.argv.slice(2));

  if (!fs.existsSync("package.json") && !isPython() && !isGo()) die("no package.json, pyproject.toml/requirements.txt, or go.mod here — run from your project root");
  if (run("git rev-parse --is-inside-work-tree").code !== 0) die("not a git repository");
  if (run("git status --porcelain").out.trim() !== "") die("working tree not clean — commit or stash first");

  if (!a.testExplicit && !a.pm.py && !a.pm.go) {
    const pj = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const t = pj.scripts && pj.scripts.test;
    if ((!t || /no test specified/i.test(t)) && pj.scripts && pj.scripts.build) {
      a.test = `${a.pm.test.split(" ")[0]} run build`;
      console.log(`→ no test script; using the build as the gate: ${a.test}`);
    } else if (t && /react-scripts test/.test(t)) {
      a.test = "CI=true npm test -- --watchAll=false";
      console.log(`→ react-scripts detected; using CI-safe gate: ${a.test}`);
    }
  }

  console.log(`→ baseline: ${a.test}`);
  const baseline = run(a.test);
  if (baseline.code !== 0) {
    console.error(baseline.out.slice(-2000));
    die(`the gate "${a.test}" is already red before any upgrade — run \`bumpwright repair\` first, or pass a working --test`);
  }

  const targets = a.workspaces && !a.pm.py ? workspaceDirs(a.pkg) : ["."];
  if (a.workspaces && !a.pm.py) console.log(`→ workspaces declaring ${a.pkg}: ${targets.join(", ")}`);
  const oldVersion = (a.pm.py ? pyCurrentVersion(a.pkg) : a.pm.go ? goCurrentVersion(a.pkg) : currentVersion(a.pkg, targets[0])) || "(not yet a dependency)";
  const branch = "bumpwright/" + `${a.pkg}-${a.version}`.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "");
  if (a.branch) {
    if (run(`git checkout -b "${branch}"`).code !== 0) die(`could not create branch ${branch} (already exists?)`);
    console.log(`→ branch ${branch}`);
  }

  const specs = [`${a.pkg}@${a.version}`];
  if (a.pm.go) {
    const cmd = `go get "${a.pkg}@${goVersionSpec(a.version)}" && go mod tidy`;
    console.log(`→ ${cmd}`);
    const inst = run(cmd);
    if (inst.code !== 0) { console.error(inst.out.slice(-3000)); die("install failed"); }
  } else if (a.pm.py) {
    const cmd = pyInstallCmd(a.pkg, a.version);
    console.log(`→ ${cmd}`);
    const inst = run(cmd);
    if (inst.code !== 0) { console.error(inst.out.slice(-3000)); die("install failed"); }
    pyRecordRequirement(a.pkg, pyCurrentVersion(a.pkg) || a.version);
  } else
  for (const dir of targets) {
    for (;;) {
      const cmd = dir === "." ? a.pm.install : a.pm.install.replace(/ -w$/, "");
      console.log(`→ ${cmd} ${specs.join(" ")}${dir === "." ? "" : ` (in ${dir})`}`);
      const inst = run(`${cmd} ${specs.map((x) => `"${x}"`).join(" ")}`, { cwd: dir });
      if (inst.code === 0) break;
      // Peer conflict: bump the blocking companion alongside the target and retry.
      const m = inst.out.match(/Conflicting peer dependency: (@?[\w./-]+)@(\d+)/);
      const okName = m && /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i.test(m[1]);
      const companion = okName ? `${m[1]}@^${m[2]}` : null;
      if (!companion || specs.includes(companion)) {
        console.error(inst.out.slice(-3000));
        die(`install failed${dir === "." ? "" : ` in ${dir}`}`);
      }
      console.log(`→ peer conflict with ${m[1]}; retrying with companion ${companion}`);
      specs.push(companion);
    }
  }
  const newVersion = (a.pm.py ? pyCurrentVersion(a.pkg) : a.pm.go ? goCurrentVersion(a.pkg) : currentVersion(a.pkg, targets[0])) || a.version;

  let result = null;
  for (let i = 0; i <= a.maxIters; i++) {
    console.log(`→ ${a.test}${i ? ` (after fix attempt ${i})` : ""}`);
    result = run(a.test);
    if (result.code === 0) break;
    if (i === a.maxIters) {
      console.error(result.out.slice(-4000));
      console.error(`\nbumpwright: tests still failing after ${a.maxIters} fix attempts.`);
      console.error(a.branch ? `Branch ${branch} left in place for manual work.` : "Changes left in working tree.");
      process.exit(1);
    }
    console.log(`✗ tests failing — fix attempt ${i + 1}/${a.maxIters}`);
    const prompt = `The npm dependency "${a.pkg}" in this repository was just upgraded from ${oldVersion} to ${newVersion}.
The test command \`${a.test}\` now fails with the output below.

Fix this repository's source code so it works with ${a.pkg}@${newVersion}.
Rules:
- Do NOT downgrade, pin, or remove ${a.pkg}. Adapt the calling code instead.
- Do NOT weaken, skip, or delete tests to make them pass; change them only where they exercise a genuinely removed/renamed API.
- Consult ${a.pkg}'s changelog or release notes for the breaking changes if useful.
- Keep the diff minimal.

Failing test output:
${result.out.slice(-8000)}`;
    const agent = spawnSync(a.agent, { shell: true, input: prompt, stdio: ["pipe", "inherit", "inherit"] });
    if ((agent.status ?? 1) !== 0) console.error("bumpwright: agent command exited non-zero, re-running tests anyway");
  }

  console.log("✓ tests passing");
  run("git add -A");
  const note = process.env.BUMPWRIGHT_NOTE ? `${process.env.BUMPWRIGHT_NOTE}\n\n` : "";
  const msg = `Upgrade ${a.pkg} ${oldVersion} -> ${newVersion} and migrate breaking changes\n\n${note}Automated by bumpwright.`;
  if (commit(msg).code !== 0) die("git commit failed");
  console.log(`✓ committed upgrade of ${a.pkg} to ${newVersion}`);

  if (a.pr) {
    if (run(`git push -u origin "${branch}"`).code !== 0) die("git push failed");
    const pr = run(`gh pr create --fill`, { stdio: ["ignore", "inherit", "inherit"], encoding: undefined });
    if (pr.code !== 0) die("gh pr create failed");
  } else if (a.branch) {
    console.log(`Review with: git diff main...${branch}`);
  }
}

main();

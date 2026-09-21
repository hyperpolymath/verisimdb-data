#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// estate-ruby-exit.mjs — perform the mechanical half of the estate's Ruby exit
// in one repo at a time.
//
// Ruby is a banned language for the estate (verisimdb-data ADR-0002). Most of
// the remaining Ruby is not code, it is a pasted "Deploy Jekyll site to Pages"
// workflow: a Ruby toolchain standing between a push and a directory copy. That
// part is mechanical, so it should be a tool, not 15 PRs of hand-editing.
//
// What it does, given a checkout:
//   1. classify every Ruby artefact it finds (adapter / packaging DSL / vendored
//      / needs-a-human) using the SAME exemptions as rsr-antipattern.yml, so the
//      tool and the gate can never disagree about what is permitted;
//   2. if the Ruby is only on the Pages path, write the reference replacement
//      (pages.yml + scripts/build-site.mjs + site.json, copied from the assets
//      dir, which defaults to verisimdb-data — the repo where this landed first),
//      delete the Jekyll workflows, and strip Ruby pins from actions.lock;
//   3. otherwise stop and report. `rake`, `rspec` and `gem install` are not
//      mechanical: they mean the repo has real Ruby behaviour to port, and a
//      tool that quietly deleted it would be worse than no tool at all.
//
// Dry-run by default. --apply writes. Nothing is committed, nothing is pushed.
//
// Usage:
//   node estate-ruby-exit.mjs /path/to/repo
//   node estate-ruby-exit.mjs /path/to/repo --apply --assets-dir /path/to/verisimdb-data
//   node estate-ruby-exit.mjs --all /path/to/clone-root   // every subdir with .git

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { argv, cwd, exit, stderr, stdout } from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RUBY_FILE = /(\.rb|\.rake|\.gemspec|Gemfile(\.lock)?$|Rakefile$|\.ruby-version$|_config\.yml$|\.jekyllrc$)/;

// Mirrors rsr-antipattern.yml exactly. Keep the two in sync or the fleet gets
// repos the tool "fixed" that CI still fails.
const EXEMPT = [
  { re: /^(?:\.\/)?(?:bindings|integrations|adapters)(?:\/[^/]+)?\/(?:ruby|helpers)\//, why: "adapter (permitted by ADR-0002)" },
  { re: /^(?:\.\/)?(?:Formula|Casks)\//, why: "Homebrew formula: the format is a Ruby DSL" },
  { re: /\/(?:homebrew|tap)\//, why: "Homebrew formula: the format is a Ruby DSL" },
  { re: /^(?:\.\/)?(?:vendor|macports-ports)\//, why: "vendored mirror of another project" },
  { re: /\/satellites\//, why: "vendored mirror of another project" },
];

// Ruby that a tool must not touch, because it is behaviour rather than plumbing.
const NEEDS_HUMAN = /\b(rspec|rubocop|gem install|bundle (exec|install)|rake)\b/;
// A line that mentions Jekyll at all is Pages plumbing: those workflows are
// deleted wholesale, so `bundle exec jekyll build` is mechanical even though
// `bundle exec rake test` is not. Kept separate from the *detection* pattern,
// which must not treat the `.nojekyll` marker as Ruby usage.
const PAGES_ONLY = /jekyll|ruby\/setup-ruby|github-pages/i;

function trackedFiles(dir) {
  const r = spawnSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" });
  if (r.status !== 0) fail(`${dir}: not a git checkout? (${r.stderr.trim() || "git ls-files failed"})`);
  return r.stdout.split("\n").filter(Boolean);
}

function fail(message) {
  stderr.write(`ruby-exit: ${message}\n`);
  exit(1);
}

function classify(dir) {
  const files = trackedFiles(dir);
  const ruby = files.filter((f) => RUBY_FILE.test(f));
  const exempt = [];
  const convert = [];
  for (const f of ruby) {
    const hit = EXEMPT.find((e) => e.re.test(`./${f}`));
    (hit ? exempt : convert).push({ file: f, why: hit?.why ?? null });
  }
  // The policy file that implements this ban contains the pattern list, so it
  // matches itself; same for this tool's own name. Skip those, exactly as the
  // CI step's --exclude does, or every converted repo looks "not yet done".
  const SELF = /(rsr-antipattern|ruby-exit|language-policy|dependabot)[^/]*\.(yml|yaml)$/;
  const ciFiles = files.filter(
    (f) => !SELF.test(f) && (f.startsWith(".github/workflows/") || f === ".gitlab-ci.yml" || f === "Justfile" || f === "justfile"),
  );
  const ci = [];
  for (const f of ciFiles) {
    const text = readFileSync(join(dir, f), "utf8").split("\n");
    text.forEach((line, i) => {
      // A comment describing the retired tooling is not usage, and neither is a
      // trailing one: `bundler-cache: true # runs 'bundle install' and caches…` is
      // GitHub's own boilerplate comment, and treating it as a Ruby invocation kept
      // two purely-mechanical repos (bebop-ffi, deed-validate-action) out of reach.
      if (/^\s*#/.test(line)) return;
      line = line.replace(/\s+#(?!\{)[^"]*$/, "");
      // Same alternation as the CI gate. Note `jekyll-build-pages`, not a bare
      // `jekyll`: `.nojekyll` is a marker file the *replacement* writes, so a loose
      // match would flag every migrated repo as still carrying Ruby (it did, on
      // filesoup/proven, whose casket-pages.yml is a Haskell build).
      // Anchored to invocation shapes, exactly as rsr-antipattern.yml now is:
      // a `uses:` step, a lockfile pin, or a command at the start of a run line.
      // Substring matching flags repos that merely *quote* the words — `echidna`
      // greps its container log for "bundle install failed" and has no Ruby.
      const INVOCATION = /uses:\s*(ruby\/setup-ruby|actions\/jekyll-build-pages)|^\s*(-\s+)?['\"]?(ruby\/setup-ruby|actions\/jekyll-build-pages)@|^\s*(-\s+)?(run:\s*)?(sudo\s+)?(gem install|bundle exec|bundle install|rake\s)/;
      if (!INVOCATION.test(line)) return;
      ci.push({ file: f, line: i + 1, text: line.trim(), mechanical: !NEEDS_HUMAN.test(line) || PAGES_ONLY.test(line) });
    });
  }
  return { convert, exempt, ci, all: files };
}

// The replacement's publish surface. The old Jekyll build published "whatever
// it walked"; an allowlist has to be derived per repo, and the derivation is
// deliberately conservative: top-level data directories plus the well-known
// bundle plus a README. Anything else is a decision a human should make.
function deriveSiteConfig(dir, title, files) {
  const all = files;
  const topDirs = new Set();
  for (const f of all) {
    const [head] = f.split("/");
    // `www/` is handled by its two explicit entries above (public/ and
    // .well-known/); mirroring the directory as well would publish the bundle
    // source at /www/ too, which is the artefact the Jekyll workflow had to
    // `rm -rf` as a cleanup step. scripts/, tests/ and tool dirs are not site
    // content either.
    if (!f.includes("/")) continue;
    if (head.startsWith(".") || ["scripts", "node_modules", "www", "test", "tests", "ffi", ".github"].includes(head)) continue;
    topDirs.add(head);
  }
  const copy = [{ from: "www/public", to: ".", required: false }, { from: "www/.well-known", to: ".well-known", required: false }];
  for (const d of [...topDirs].sort()) copy.push({ from: d, to: d, required: false });
  for (const f of ["README.adoc", "README.md", "index.json"]) {
    if (all.includes(f)) copy.push({ from: f, to: f, required: false });
  }
  const listing = all.some((f) => f.startsWith("docs/"))
    ? [{ root: "docs", label: "Documentation", match: [".adoc", ".md"], link_target: "source" }]
    : [];
  return {
    title,
    output: "_site",
    index_page: all.includes("index.json") ? "hub/index.html" : "index.html",
    copy,
    listing,
    nojekyll: true,
    notes: [
      "Derived by scripts/estate-ruby-exit.mjs — review before merge.",
      "index_page is hub/index.html when the repo publishes index.json: GitHub Pages",
      "serves index.json for '/' if no index.html exists, and some consumers rely on it.",
    ],
  };
}

function buildPagesWorkflow(siteJsonPath) {
  return `# SPDX-License-Identifier: MPL-2.0
#
# Generated by scripts/estate-ruby-exit.mjs — Ruby-free Pages deploy.
# Replaces the Jekyll workflow (ruby/setup-ruby or actions/jekyll-build-pages):
# Ruby is banned for this estate, see hyperpolymath/verisimdb-data ADR-0002.
name: Deploy Pages site

on:
  push:
    branches: ["main", "master"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v7.0.1
      - name: Setup Pages
        id: pages
        uses: actions/configure-pages@v6.0.0
      - name: Build site and prove reproducibility
        env:
          BASE_PATH: \${{ steps.pages.outputs.base_path }}
        run: |
          set -euo pipefail
          if command -v bun >/dev/null 2>&1; then runtime="bun run"; else runtime="node"; fi
          echo "build runtime: $runtime"
          $runtime scripts/build-site.mjs --config ${siteJsonPath} --baseurl "$BASE_PATH" | tee /tmp/build-1.log
          rm -rf _site
          $runtime scripts/build-site.mjs --config ${siteJsonPath} --baseurl "$BASE_PATH" | tee /tmp/build-2.log
          first=$(sed -n 's/.*\\(sha256=[0-9a-f]\\{64\\}\\).*/\\1/p' /tmp/build-1.log | head -1)
          second=$(sed -n 's/.*\\(sha256=[0-9a-f]\\{64\\}\\).*/\\1/p' /tmp/build-2.log | head -1)
          if [ -z "$first" ] || [ "$first" != "$second" ]; then
            echo "::error::site build is not reproducible ($first vs $second)"
            exit 1
          fi
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v5.0.0
        with:
          path: _site
          include-hidden-files: true

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5.0.1
`;
}

// actions.lock is machine-generated, so the honest edit is to delete the Ruby
// pins and say "regenerate me"; leaving them would keep dependabot interested.
const RUBY_LOCK_KEY = /ruby\/setup-ruby|jekyll|github-pages/;

// actions.lock is machine-generated, so the honest edit is: drop the Ruby keys
// whole and leave a note to regenerate. Deleting a single `uses:` line under a
// workflow key while its siblings stay behind produces invalid YAML, so an
// entry is removed as a unit — key line plus every line indented under it.
function stripLockPins(dir) {
  const path = join(dir, ".github/workflows/actions.lock");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  const out = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isKey = /^ {4}'[^']*':/.test(line);
    if (isKey && RUBY_LOCK_KEY.test(line)) {
      dropped += 1;
      while (i + 1 < lines.length && /^ {8,}\S/.test(lines[i + 1])) { i += 1; dropped += 1; }
      continue;
    }
    if (!isKey && RUBY_LOCK_KEY.test(line)) { dropped += 1; continue; }
    out.push(line);
  }
  return { text: out.join("\n"), dropped };
}

function planFor(dir, opts) {
  const { convert, exempt, ci, all } = classify(dir);
  const nonMechanical = ci.filter((c) => !c.mechanical);
  const actions = [];
  const removals = [...new Set(ci.map((c) => c.file))].filter((f) => f.startsWith(".github/workflows/")).sort();
  const jekyllWorkflows = removals.filter((f) => /jekyll|pages/i.test(basename(f)));

  if (convert.length > 0 || nonMechanical.length > 0) {
    actions.push("STOP: not mechanical");
  }
  if (convert.length > 0) actions.push(`port ${convert.length} Ruby file(s) by hand first`);
  if (nonMechanical.length > 0) actions.push(`resolve ${nonMechanical.length} non-Pages Ruby CI invocation(s) first`);
  if (jekyllWorkflows.length > 0) {
    actions.push(`delete ${jekyllWorkflows.join(", ")}`);
    actions.push("write .github/workflows/pages.yml + scripts/build-site.mjs + site.json");
    actions.push("strip Ruby pins from actions.lock, then run `gh actions-lock`");
    actions.push("add ruby/setup-ruby + actions/jekyll-build-pages to dependabot ignores");
  }
  return { convert, exempt, ci, all, nonMechanical, jekyllWorkflows, actions };
}

function applyTo(dir, plan, opts) {
  const assets = resolve(opts.assetsDir);
  const title = basename(dir.replace(/\/+$/, ""));
  const site = deriveSiteConfig(dir, title, plan.all);
  const written = [];

  for (const wf of plan.jekyllWorkflows) {
    rmSync(join(dir, wf), { force: true });
    written.push(`deleted ${wf}`);
  }
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(assets, "scripts/build-site.mjs"), join(dir, "scripts/build-site.mjs"));
  written.push("wrote scripts/build-site.mjs");
  writeFileSync(join(dir, "site.json"), `${JSON.stringify(site, null, 2)}\n`);
  written.push("wrote site.json");
  writeFileSync(join(dir, ".github/workflows/pages.yml"), buildPagesWorkflow("site.json"));
  written.push("wrote .github/workflows/pages.yml");
  const lock = stripLockPins(dir);
  if (lock !== null && lock.dropped > 0) {
    writeFileSync(join(dir, ".github/workflows/actions.lock"), lock.text);
    written.push(`stripped ${lock.dropped} Ruby line(s) from actions.lock`);
  }
  if (!existsSync(join(dir, ".gitignore")) || !readFileSync(join(dir, ".gitignore"), "utf8").includes("_site")) {
    const gi = existsSync(join(dir, ".gitignore")) ? readFileSync(join(dir, ".gitignore"), "utf8") : "";
    writeFileSync(join(dir, ".gitignore"), `${gi}\n# Pages output\n/_site/\n`);
    written.push("added /_site/ to .gitignore");
  }
  const db = join(dir, ".github/dependabot.yml");
  if (existsSync(db)) {
    let text = readFileSync(db, "utf8");
    if (!text.includes("ruby/setup-ruby")) {
      text = text.replace(
        /(package-ecosystem:\s*"github-actions"[^\n]*\n)/,
        `$1    # Ruby is banned for this estate: bump the action, or delete it? Delete.\n    ignore:\n      - dependency-name: "ruby/setup-ruby"\n      - dependency-name: "actions/jekyll-build-pages"\n`,
      );
      writeFileSync(db, text);
      written.push("added dependabot ignores for Ruby tooling");
    }
  }
  return written;
}

function report(dir, plan, opts) {
  const name = basename(dir.replace(/\/+$/, ""));
  const nothing = plan.ci.length === 0 && plan.convert.length === 0 && plan.exempt.length === 0;
  const mechanical = plan.convert.length === 0 && plan.nonMechanical.length === 0 && plan.jekyllWorkflows.length > 0;
  if (nothing) {
    stdout.write(`\n=== ${name} ===\n  no Ruby anywhere: nothing to do\n`);
    return "clean";
  }
  stdout.write(`\n=== ${name} ===\n`);
  stdout.write(`  Ruby on build path: ${plan.ci.length}  |  source to port: ${plan.convert.length}  |  exempt: ${plan.exempt.length}\n`);
  for (const c of plan.ci) stdout.write(`    ${c.file}:${c.line}  ${c.mechanical ? "[mechanical]" : "[NEEDS HUMAN]"}  ${c.text.slice(0, 90)}\n`);
  for (const f of plan.convert) stdout.write(`    port: ${f.file}\n`);
  for (const f of plan.exempt.slice(0, 6)) stdout.write(`    exempt (${f.why}): ${f.file}\n`);
  if (plan.exempt.length > 6) stdout.write(`    … and ${plan.exempt.length - 6} more exempt\n`);
  for (const a of plan.actions) stdout.write(`  → ${a}\n`);
  if (plan.jekyllWorkflows.length === 0 && plan.convert.length === 0 && plan.exempt.length > 0) {
    stdout.write("  → nothing to do: Ruby here is only permitted adapters\n");
    return "clean";
  }
  if (mechanical && opts.apply) {
    for (const line of applyTo(dir, plan, opts)) stdout.write(`  ✓ ${line}\n`);
    return "done";
  }
  if (mechanical) {
    stdout.write("  (dry run: pass --apply to write the replacement)\n");
    return "ready";
  }
  return "blocked";
}

function main() {
  const opts = { apply: false, assetsDir: "/home/user/verisimdb-data", all: null };
  const dirs = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--assets-dir") opts.assetsDir = argv[++i];
    else if (a === "--all") { const root = resolve(argv[++i]); for (const d of readdirSync(root)) { const p = join(root, d); if (existsSync(join(p, ".git"))) dirs.push(p); } }
    else dirs.push(resolve(a));
  }
  if (dirs.length === 0) fail("usage: estate-ruby-exit.mjs <repo-dir> [--apply] [--assets-dir DIR] | --all <clone-root>");
  if (!existsSync(join(resolve(opts.assetsDir), "scripts/build-site.mjs"))) {
    fail(`assets dir ${opts.assetsDir} has no scripts/build-site.mjs (point --assets-dir at the reference repo)`);
  }
  const tally = { clean: 0, ready: 0, done: 0, blocked: 0 };
  for (const dir of dirs) tally[report(dir, planFor(dir, opts), opts)] += 1;
  const parts = [];
  if (tally.done) parts.push(`${tally.done} converted`);
  if (tally.ready) parts.push(`${tally.ready} ready to convert (dry run)`);
  if (tally.blocked) parts.push(`${tally.blocked} needing a human`);
  if (tally.clean) parts.push(`${tally.clean} already clear`);
  stdout.write(`\nruby-exit: ${parts.join(", ") || "nothing to do"}\n`);
  // Non-zero only when a --apply run left something behind, so a fleet loop can
  // tell "needs a human" apart from "finished" without parsing prose.
  exit(tally.blocked > 0 && opts.apply ? 2 : 0);
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) main();

export { classify, deriveSiteConfig, planFor, stripLockPins, EXEMPT, RUBY_FILE };

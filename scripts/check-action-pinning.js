#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0
//
// Assert every workflow action ref is pinned — inline SHA, or via actions.lock.
//
// What counts as "pinned" changed when GitHub introduced workflow lockfiles. A
// ref is pinned if EITHER it is an inline 40-hex SHA, OR
// .github/workflows/actions.lock resolves it to one. The previous inline-only
// rule rejected all 40 of this repo's own refs, so `Workflow Security Linter`
// was red on main permanently — and every repo minted from this template
// inherited both the tag-form workflows and the gate that rejects them.
//
// Runtime: Bun — the estate's first-choice runtime per LANGUAGE-POLICY.adoc §1
// (Bun > Deno > pnpm > npm). Plain JavaScript, not TypeScript: TypeScript is
// banned estate-wide (owner ruling; CLAUDE.md banned-languages table). Note
// LANGUAGE-POLICY.adoc §1.2 currently claims TS is "permitted under Bun" — that
// line is wrong and should be corrected; the ban stands.
//
// Python was the first draft of this script and is banned with no exceptions.
//
// Three details are load-bearing, each of them a defect found by testing:
//
//   `-?` in the pattern. `- uses:` is the list-item form and by far the most
//   common; a `\s+uses:` pattern silently misses every one of them. Estate
//   memory records this exact failure — "green linter != full SHA-pinning". A
//   gate that cannot see the common case reads as coverage and enforces nothing.
//
//   Case-insensitive comparison. Workflows write `SonarSource/...`; the lockfile
//   records `sonarsource/...`. Action refs are case-insensitive in practice, so
//   a case-sensitive match reports a false positive on a correctly-pinned action.
//
//   Only *.yml / *.yaml, depth 1. A bare recursive grep also reads actions.lock
//   (whose `uses:` keys are lockfile entries, not refs) and *.yml.template
//   (whose tag ref is deliberate and resolved at mint time). Both were reported
//   as unpinned, which made the gate unsatisfiable the moment a lockfile existed.
//
// Exit 0 if every ref is pinned, 1 otherwise, listing file:line: ref.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const WF = ".github/workflows";
const LOCK = join(WF, "actions.lock");
// `-?` matches the list-item form; see the header.
const USES = /^\s*-?\s*uses:\s*([^\s#]+)/;
const SHA = /@[a-f0-9]{40}$/;
const EXEMPT_PREFIX = ["./", "$", "docker://"];

function workflowFiles() {
  if (!existsSync(WF) || !statSync(WF).isDirectory()) return [];
  return readdirSync(WF)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => join(WF, f));
}

function main() {
  if (!existsSync(WF)) {
    console.log("no .github/workflows — nothing to check");
    return 0;
  }

  let known = new Set();
  if (existsSync(LOCK)) {
    const lock = readFileSync(LOCK, "utf8");
    known = new Set(
      [...lock.matchAll(/'([^']+@[^']+)'/g)].map((m) => m[1].toLowerCase()),
    );
    console.log(`lockfile present: ${known.size} ref(s) resolvable through it`);
  } else {
    console.log("no lockfile — every ref must be an inline 40-character SHA");
  }

  const bad = [];
  for (const wf of workflowFiles()) {
    const lines = readFileSync(wf, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = USES.exec(line);
      if (!m) return;
      const ref = m[1];
      if (EXEMPT_PREFIX.some((p) => ref.startsWith(p))) return;
      if (ref.includes("actions/github-script")) return;
      if (SHA.test(ref)) return;
      const at = ref.lastIndexOf("@");
      const name = at === -1 ? ref : ref.slice(0, at);
      const tag = at === -1 ? "" : ref.slice(at + 1);
      // subpath actions key by repo root: github/codeql-action/init -> github/codeql-action
      const root = name.split("/").slice(0, 2).join("/");
      if (known.has(ref.toLowerCase()) || known.has(`${root}@${tag}`.toLowerCase())) return;
      bad.push(`${wf}:${i + 1}: ${ref}`);
    });
  }

  if (bad.length) {
    console.log("\nERROR: these action refs are neither SHA-pinned nor covered by the lockfile:");
    for (const b of bad) console.log(`  ${b}`);
    console.log("\nEither pin to a full commit SHA, or run `gh actions-lock` so the");
    console.log("lockfile resolves the ref.");
    return 1;
  }
  console.log("all action refs are pinned");
  return 0;
}

process.exit(main());

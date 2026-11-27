#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0
//
// Assert every workflow action ref is pinned — inline SHA, or via actions.lock.
//
// What counts as "pinned" changed when GitHub introduced workflow lockfiles. A
// ref is pinned if EITHER it is an inline 40-hex SHA, OR
// .github/workflows/actions.lock resolves it to one FOR THAT WORKFLOW. The
// previous inline-only rule rejected all 40 of this repo's own refs, so
// `Workflow Security Linter` was red on main permanently — and every repo minted
// from this template inherited both the tag-form workflows and the gate that
// rejects them.
//
// "Resolves it" is checked in full, not by the ref's mere presence in the file:
//   1. the workflow has its own entry under `workflows:` in the lock — GitHub
//      onboards workflows one at a time, and a workflow with no entry resolves
//      its tag at run time, whatever other workflows are locked;
//   2. that entry lists the ref (or the ref's repository root, for a subpath
//      action such as github/codeql-action/init);
//   3. the `dependencies:` section holds the same ref with a
//      `commit: 'sha1-<40 hex>'`.
//
// Runtime: Bun — the estate's first-choice runtime per LANGUAGE-POLICY.adoc §1
// (Bun > Deno > pnpm > npm). Plain JavaScript, not TypeScript: TypeScript is
// banned estate-wide (owner ruling; CLAUDE.md banned-languages table). Note
// LANGUAGE-POLICY.adoc §1.2 currently claims TS is "permitted under Bun" — that
// line is wrong and should be corrected; the ban stands.
//
// Python was the first draft of this script and is banned with no exceptions.
//
// Each of these is load-bearing and has a mutation test in
// tests/workflows/check_action_pinning_test.sh:
//
//   `-?` in the pattern. `- uses:` is the list-item form and by far the most
//   common; a `\s+uses:` pattern silently misses every one of them. Estate
//   memory records this exact failure — "green linter != full SHA-pinning". A
//   gate that cannot see the common case reads as coverage and enforces nothing.
//
//   Position. A `uses` key is an action only at jobs.<id>.uses (a reusable
//   workflow) or jobs.<id>.steps[].uses, so `env: { uses: x }` and a `uses`
//   input under `with:` are not refs. The scan tracks the path of every block
//   and flow node, including indentless sequences, document markers and block
//   scalars (whose text is never read as keys). Where the path cannot be known
//   it fails closed and counts every `uses` key: in the whole file when it
//   has an alias (`*a`, `<<: *a`), which can put any node at any path, and
//   from the first line it cannot place (an unclosed flow collection or quoted
//   scalar, a stray `,` `}` `]`) to the end of the file.
//
//   Flow mappings. `- { uses: x@v1 }` and `{ name: n, uses: x@v1 }` are the same
//   step as the block form; a flow collection opens only where a node begins
//   with `{` or `[`, so `{ uses: ... }` inside a comment or a quoted shell
//   argument is not a step. In block form the scalar runs to the end of the
//   line (or a ` #` comment): a `,` is part of it, so `x@<sha>,mutable` is a
//   mutable tag, not a pinned SHA. A flow collection left open at the end of a
//   line continues on the deeper-indented lines after it and is read as one.
//
//   Node properties. An anchor (`&s`) or tag (`!!map`) before a step, a key or
//   a value changes nothing it holds, so `- &s { uses: x@v1 }` is a step, and
//   a key keeps the column its properties start at, so `&j jobs:` is `jobs`.
//
//   Quoted keys and values. `uses: 'x@v1'` and `uses: x@v1` are the same YAML
//   scalar. A quoted scalar is read to its real closing quote (`''` is an
//   escaped `'`), and double-quoted escapes are decoded, so `"u\x73es"` is
//   the key `uses`.
//
//   One line per ref. A `uses` value that does not end on its key's line (an
//   empty value, a quote left open, a plain scalar continued on a deeper line)
//   is reported as an error rather than guessed at; so is an explicit `? key`
//   entry and an alias used as a key (`*u : x`), whose keys the scan does not
//   read.
//
//   List dashes. `-` may be followed by a tab as well as a space.
//
//   Case. Workflows write `SonarSource/...`; the lockfile records
//   `sonarsource/...`, so the owner/repository part is compared case-
//   insensitively. The tag is compared exactly (git ref names are case-
//   sensitive), and so is the workflow path (ci.yml and CI.yml can coexist).
//
//   Only *.yml / *.yaml, depth 1. A bare recursive grep also reads actions.lock
//   (whose `uses:` keys are lockfile entries, not refs) and *.yml.template
//   (whose tag ref is deliberate and resolved at mint time). Both were reported
//   as unpinned, which made the gate unsatisfiable the moment a lockfile existed.
//
//   The actions/github-script exemption compares the repository name exactly.
//   A substring test would let any repository whose name contains that text skip
//   every check.
//
// Exit 0 if every ref is pinned, 1 otherwise, listing `file:line: ref (reason)`
// for each unpinned ref and `file:line: reason` for each value it cannot read.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const WF = ".github/workflows";
const LOCK = join(WF, "actions.lock");
const FLOW_INDICATOR = "{}[],";
// A block sequence dash: `-` then spaces or tabs, or `-` alone at the line end.
const DASH = /^-(?:[ \t]+|$)/;
// A node property: an anchor (`&name`) or a tag (`!t`, `!!map`, `!<uri>`).
// Neither changes the node's content, so both are skipped before it is read.
const PROPS = /^[&!]\S*(?:[ \t]+|$)/;
// An explicit `? key` entry, which this gate does not read (see EXPLICIT_WHY).
const EXPLICIT = /^\?(?:[ \t]|$)/;
const EXPLICIT_WHY = "explicit `? key` entry: not read by this gate; write the key inline";
// An alias used as a mapping key (`*u : x`): the key is another node's value.
const ALIAS_KEY = /^\*[^\s,[\]{}]+[ \t]*:(?:\s|$)/;
const ALIAS_KEY_WHY = "alias `*name` as a key: not read by this gate; write the key inline";
const SPLIT_WHY = "no ref on the `uses` line: write the whole ref on that line";
// `---` or `...` in column 0 starts or ends a YAML document.
const DOC_MARK = /^(?:---|\.\.\.)(?:\s|$)/;
// A YAML alias (`*name`, which `<<: *name` merges also use). Over-matching
// (`ls *.txt` in a script) only turns position filtering off, never on.
const ALIAS = /(?:^|[\s,[{])\*[^\s,[\]{}]/m;
// The double-quoted escapes YAML defines beside \x, \u and \U.
const ESCAPES = {
  0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f",
  r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\",
  N: "\x85", _: "\xa0", L: "\u2028", P: "\u2029",
};
const SHA = /@[a-f0-9]{40}$/;
// The lock writes a resolved commit as `sha1-` plus 40 lower-case hex digits.
const LOCK_COMMIT = /^sha1-[0-9a-f]{40}$/;
const EXEMPT_PREFIX = ["./", "$", "docker://"];
const EXEMPT_REPO = "actions/github-script";

function workflowFiles() {
  if (!existsSync(WF) || !statSync(WF).isDirectory()) return [];
  return readdirSync(WF)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

// `'x'` -> `x`; the lock quotes every key and value it writes.
function unquote(s) {
  return s.length > 1 && s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1) : s;
}

// A double-quoted scalar's body with its escapes decoded. An escape YAML does
// not define is kept as written: a `\` is never part of a 40-hex SHA, so such a
// ref fails closed.
function unescapeDouble(body) {
  return body.replaceAll(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[^])/g, (m, e) => {
    if (e.length === 1) return ESCAPES[e] ?? m;
    const code = Number.parseInt(e.slice(1), 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

// `s` with any leading node properties (anchors, tags) removed.
function stripProps(s) {
  let out = s;
  while (PROPS.test(out)) out = out.replace(PROPS, "");
  return out;
}

// A YAML plain or quoted scalar -> its string value: node properties skipped,
// matching quotes removed, `''` in a single-quoted scalar read as one `'`, and
// double-quoted escapes decoded, so `"u\x73es"` is the key `uses`.
function decode(raw) {
  const s = stripProps(raw.trim());
  const q = s[0];
  if ((q === "'" || q === '"') && s.length > 1 && quoteEnd(s, 0) === s.length - 1) {
    const body = s.slice(1, -1);
    return q === "'" ? body.replaceAll("''", "'") : unescapeDouble(body);
  }
  return s;
}

// One flow token at t[i]: an indicator, a `:`, or a scalar (quoted or plain).
// A plain scalar stops at a flow indicator, at `: ` (a `:` before a blank, an
// indicator or the end), or at ` #`; a `#` with no blank before it is part of
// the value (YAML starts a comment only at ` #`), so `x@<sha>#tag` is read whole.
// Returns [token, next index]; a token is { p: indicator } or { v: raw scalar }.
function flowToken(t, i, afterQuoted) {
  const c = t[i];
  if (FLOW_INDICATOR.includes(c)) return [{ p: c }, i + 1];
  if (c === ":" && (afterQuoted || colonEnds(t, i))) return [{ p: ":" }, i + 1];
  if (c === "'" || c === '"') return quotedToken(t, i);
  return plainToken(t, i);
}

// A `:` that ends a key: followed by a blank, a flow indicator or the end.
function colonEnds(t, j) {
  if (t[j] !== ":") return false;
  return j + 1 >= t.length || /\s/.test(t[j + 1]) || FLOW_INDICATOR.includes(t[j + 1]);
}

// Index of the closing quote of the scalar opened at t[i] (or t.length):
// `\x` escapes in double quotes, `''` in single quotes.
function quoteEnd(t, i) {
  const c = t[i];
  let j = i + 1;
  while (j < t.length && t[j] !== c) {
    j += c === '"' && t[j] === "\\" ? 2 : 1;
  }
  if (c === "'" && t[j + 1] === "'") return quoteEnd(t, j + 1);
  return j;
}

function quotedToken(t, i) {
  const j = quoteEnd(t, i);
  return [{ v: t.slice(i, j + 1), q: true }, j + 1];
}

function plainEnds(t, j) {
  return FLOW_INDICATOR.includes(t[j]) || colonEnds(t, j) || (t[j] === "#" && /\s/.test(t[j - 1]));
}

function plainToken(t, i) {
  let j = i;
  while (j < t.length && !plainEnds(t, j)) j += 1;
  return [{ v: t.slice(i, j).trimEnd() }, j];
}

// The tokens of a flow collection, which may span lines; a ` #` comment runs to
// the end of its line.
function flowTokens(t) {
  const toks = [];
  let i = 0;
  while (i < t.length) {
    if (/\s/.test(t[i])) {
      i += 1;
      continue;
    }
    if (t[i] === "#" && (i === 0 || /\s/.test(t[i - 1]))) {
      const eol = t.indexOf("\n", i);
      if (eol === -1) break;
      i = eol;
      continue;
    }
    const [tok, next] = flowToken(t, i, toks.at(-1)?.q === true);
    toks.push(tok);
    i = next;
  }
  return toks;
}

// Action refs are case-insensitive in the owner/repository part and case-
// sensitive in the tag (git ref names are), so lower-case only the former.
function normRef(ref) {
  const at = ref.lastIndexOf("@");
  return at === -1 ? ref.toLowerCase() : ref.slice(0, at).toLowerCase() + ref.slice(at);
}

// A line split into the columns of its list dashes, the column of the node
// after them, and that node's text. Node properties are skipped in the text
// (`- &s { uses: x }` is a step) but not in the column: `&j jobs:` is a key
// at column 0, which is what its children's indentation is measured against.
// YAML separates a `-` from its entry with spaces or tabs.
function lineShape(line) {
  const dashes = [];
  let pos = indentOf(line);
  let col = pos;
  for (;;) {
    const rest = line.slice(pos);
    const m = DASH.exec(rest) ?? PROPS.exec(rest);
    if (m === null) break;
    if (rest[0] === "-") dashes.push(pos);
    pos += m[0].length;
    if (rest[0] === "-") col = pos;
  }
  return { dashes, col, body: line.slice(pos) };
}

// The block-mapping key `body` starts with, as { name, rest } (rest is the text
// after the `:`), or null. A quoted key may meet its `:` directly; a plain key
// ends at a `:` before a blank or the end of the line. `uses:x` is also taken as
// the key `uses`, as the gate always has: reading too much fails closed.
function blockKey(body) {
  const q = body[0];
  if (q === "'" || q === '"') {
    const close = quoteEnd(body, 0);
    const colon = /^[ \t]*:/.exec(body.slice(close + 1));
    if (close >= body.length || colon === null) return null;
    return { name: decode(body.slice(0, close + 1)), rest: body.slice(close + 1 + colon[0].length) };
  }
  const plainUses = /^uses[ \t]*:/.exec(body);
  if (plainUses !== null) return { name: "uses", rest: body.slice(plainUses[0].length) };
  const at = body.search(/:(?:\s|$)/);
  if (at <= 0 || "{[#|>*".includes(body[0])) return null;
  return { name: decode(body.slice(0, at)), rest: body.slice(at + 1) };
}

// Whether a quoted scalar opens at the start of `s` and does not close on it.
function openQuote(s) {
  return (s[0] === "'" || s[0] === '"') && quoteEnd(s, 0) >= s.length;
}

// What a block `uses:` value declares: { ref }, or { why } when the value does
// not end on the key's line (it is empty, a quote stays open, or the next
// line is deeper and so continues the scalar).
function usesValue(rest, lines, i, keyCol) {
  const v = stripProps(rest.trim());
  if (v === "" || v[0] === "#" || openQuote(v) || continues(lines, i, keyCol)) return { why: SPLIT_WHY };
  if (v[0] === "'" || v[0] === '"') return { ref: decode(v.slice(0, quoteEnd(v, 0) + 1)) };
  const hash = v.search(/\s#/);
  return { ref: decode(hash === -1 ? v : v.slice(0, hash)) };
}

// Whether the next line that is not blank or a comment is indented deeper than
// `col`: under a scalar `uses:` value that can only be its continuation.
function continues(lines, i, col) {
  for (let j = i + 1; j < lines.length; j += 1) {
    const s = lines[j].trim();
    if (s !== "" && s[0] !== "#") return indentOf(lines[j]) > col;
  }
  return false;
}

// How many flow collections the tokens leave open.
function flowDepth(toks) {
  let depth = 0;
  for (const { p } of toks) {
    if (p === "{" || p === "[") depth += 1;
    else if (p === "}" || p === "]") depth -= 1;
  }
  return depth;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// The text of the flow collection that lines[i] opens at column `at`, and the
// index of the first line after it. A collection left open continues on the
// next lines, but only on lines indented deeper than lines[i] (or blank):
// YAML requires that of a flow continuation, and it keeps an unbalanced `{` in
// a block scalar from swallowing the steps that follow it. Stopping early
// loses nothing: the lines after the stop are read on their own.
function flowSpan(lines, i, at) {
  const head = lines[i].slice(at);
  const text = (end) => [head, ...lines.slice(i + 1, end)].join("\n");
  const deeper = (l) => l.trim() === "" || indentOf(l) > indentOf(lines[i]);
  let j = i + 1;
  while (j < lines.length && deeper(lines[j]) && flowDepth(flowTokens(text(j))) > 0) j += 1;
  return [text(j), j];
}

// Whether `v` (a key's value) opens a block scalar (`|`, `>-`, `|2+` ...).
const BLOCK_SCALAR = /^[|>][0-9+-]*[ \t]*(?:#.*)?$/;

// Pop the block nodes a line at these columns closes, then open its list items.
// A dash at the column of the key above it is that key's (indentless) sequence;
// a key at the column of a sequence's dash ends the sequence.
function place(st, dashes, col) {
  const first = dashes[0] ?? col;
  const dash = dashes.length > 0;
  while (st.length > 0) {
    const top = st.at(-1);
    if (top.col < first || (top.col === first && dash && top.seg !== "[]")) break;
    st.pop();
  }
  for (const d of dashes) st.push({ col: d, seg: "[]" });
}

// The first line after the block scalar whose key sits at column `col`.
function blockScalarEnd(lines, i, col) {
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > col)) j += 1;
  return j;
}

// The `uses` keys a flow collection at lines[i], column `at`, declares, and the
// first line after it. A collection left open (or over-closed) where flowSpan
// stops cannot be placed, so the rest of the file is read uncertain.
function flowAt(lines, i, at, path, state) {
  const [text, next] = flowSpan(lines, i, at);
  const toks = flowTokens(text);
  if (flowDepth(toks) !== 0) state.uncertain = true;
  return [flowRefs(toks, path).map((r) => ({ line: i, ...r })), next];
}

// The `uses` keys declared from lines[i] in block context, each as
// { line, path, ref } or { line, path, why }, and the index of the next line.
// `state.st` holds the open block nodes; `state.uncertain` is set once a line
// cannot be placed in the document (a stray `,` `}` `]`, an open flow
// collection or quoted scalar), after which every `uses` key is counted.
function lineRefs(lines, i, state) {
  let line = lines[i];
  const mark = DOC_MARK.exec(line);
  if (mark !== null) {
    // A new document: nothing is open. Its first node may follow the marker
    // on the same line, so blank the marker out and read the rest.
    state.st = [];
    line = " ".repeat(mark[0].length) + line.slice(mark[0].length);
  }
  const { dashes, col, body } = lineShape(line);
  if (dashes.length === 0 && (body === "" || body[0] === "#")) return [[], i + 1];
  place(state.st, dashes, col);
  const path = state.st.map((n) => n.seg);
  if (body === "" || body[0] === "#") return [[], i + 1];
  if (EXPLICIT.test(body)) return [[{ line: i, path: null, why: EXPLICIT_WHY }], i + 1];
  if (ALIAS_KEY.test(body)) return [[{ line: i, path: null, why: ALIAS_KEY_WHY }], i + 1];
  if (body[0] === "{" || body[0] === "[") return flowAt(lines, i, line.length - body.length, path, state);
  if (",}]".includes(body[0])) {
    state.uncertain = true;
    return [[], i + 1];
  }
  const key = blockKey(body);
  if (key === null) {
    if (openQuote(body)) state.uncertain = true;
    return [[], i + 1];
  }
  state.st.push({ col, seg: key.name });
  const keyPath = [...path, key.name];
  if (key.name.toLowerCase() === "uses") {
    return [[{ line: i, path: keyPath, ...usesValue(key.rest, lines, i, col) }], i + 1];
  }
  const v = stripProps(key.rest.trimStart());
  if (v[0] === "{" || v[0] === "[") return flowAt(lines, i, line.length - v.length, keyPath, state);
  if (BLOCK_SCALAR.test(v)) return [[], blockScalarEnd(lines, i, col)];
  if (openQuote(v)) state.uncertain = true;
  return [[], i + 1];
}

// The `uses` keys in a flow collection's tokens, each as { path, ref } or
// { path, why }. `prefix` is the block path the collection sits at; the walk
// adds a `[]` for each sequence and the key of each mapping it is inside.
function flowRefs(toks, prefix) {
  const out = [];
  const ctx = [];
  for (let k = 0; k < toks.length; k += 1) {
    const { p, v } = toks[k];
    if (p === "{" || p === "[") ctx.push({ seq: p === "[", key: null });
    else if (p === "}" || p === "]") ctx.pop();
    else if (p === "," && ctx.length > 0) ctx.at(-1).key = null;
    else if (v !== undefined && toks[k + 1]?.p === ":") {
      const found = flowKey(toks, k, ctx, prefix);
      if (found !== null) out.push(found);
    }
  }
  return out;
}

// The flow pair whose key is toks[k]: null unless the key is `uses`.
function flowKey(toks, k, ctx, prefix) {
  const raw = toks[k].v;
  if (EXPLICIT.test(stripProps(raw))) return { path: null, why: EXPLICIT_WHY };
  if (stripProps(raw.trim())[0] === "*") return { path: null, why: ALIAS_KEY_WHY };
  const name = decode(raw);
  if (ctx.length > 0) ctx.at(-1).key = name;
  if (name.toLowerCase() !== "uses") return null;
  const inner = ctx.flatMap((c) => (c.seq ? ["[]"] : []).concat(c.key === null ? [] : [c.key]));
  const path = ctx.length === 0 ? null : [...prefix, ...inner];
  const value = toks[k + 2]?.v;
  if (value === undefined || value === "") return { path, why: SPLIT_WHY };
  return { path, ref: decode(value) };
}

// Whether a key path is where a workflow names an action: jobs.<id>.uses (a
// reusable workflow) or jobs.<id>.steps[].uses. Keys compare case-insensitively.
function isActionPath(path) {
  const p = path.map((s) => s.toLowerCase());
  if (p[0] !== "jobs" || p.at(-1) !== "uses") return false;
  return p.length === 3 || (p.length === 5 && p[2] === "steps" && p[3] === "[]");
}

// Every action ref in a workflow's text, as { line, ref } or { line, why }.
// A file with an alias is read without paths (an alias can place any node at
// any path), as is the rest of a file once a line cannot be placed.
function declaredRefs(text) {
  const lines = text.split("\n");
  const anyPath = ALIAS.test(text);
  const state = { st: [], uncertain: false };
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const [items, next] = lineRefs(lines, i, state);
    for (const { path, ...item } of items) {
      if (anyPath || state.uncertain || path === null || isActionPath(path)) out.push(item);
    }
    i = next;
  }
  return out;
}

// Line-based read of the two sections of actions.lock that matter:
//   workflows:    "<path>": [ "<ref>", ... ]
//   dependencies: "<ref>":  { commit: "sha1-..." , ... }
// Workflow paths keep their case (a Linux checkout can hold ci.yml and CI.yml);
// action refs are normalised by normRef.
function parseLock(text) {
  const st = { workflows: new Map(), deps: new Map(), section: "", key: "" };
  for (const line of text.split("\n")) lockLine(st, line);
  return { workflows: st.workflows, deps: st.deps };
}

// workflows: path -> Set of refs; deps: ref -> commit string ("" when absent).
function lockLine(st, line) {
  const body = line.trim();
  if (body === "" || body.startsWith("#")) return;
  const indent = line.length - line.trimStart().length;
  if (indent === 0) {
    st.section = body.endsWith(":") ? body.slice(0, -1) : "";
    st.key = "";
  } else if (indent === 4 && body.endsWith(":")) {
    lockEntry(st, unquote(body.slice(0, -1)));
  } else if (indent === 8 && st.key !== "") {
    lockField(st.section, st.key, body, st.workflows, st.deps);
  }
}

function lockEntry(st, name) {
  st.key = lockKey(st.section, name);
  if (st.section === "workflows" && !st.workflows.has(st.key)) st.workflows.set(st.key, new Set());
  if (st.section === "dependencies" && !st.deps.has(st.key)) st.deps.set(st.key, "");
}

function lockKey(section, name) {
  return section === "workflows" ? name : normRef(name);
}

function lockField(section, key, body, workflows, deps) {
  if (section === "workflows" && body.startsWith("- ")) {
    workflows.get(key).add(normRef(unquote(body.slice(2).trim())));
  } else if (section === "dependencies" && body.startsWith("commit:")) {
    deps.set(key, unquote(body.slice("commit:".length).trim()));
  }
}

// Why `ref` (declared in workflow `wfPath`) is not pinned, or null when it is.
function unpinnedReason(ref, wfPath, lock) {
  if (EXEMPT_PREFIX.some((p) => ref.startsWith(p))) return null;
  const at = ref.lastIndexOf("@");
  const name = at === -1 ? ref : ref.slice(0, at);
  const tag = at === -1 ? "" : ref.slice(at + 1);
  if (name.toLowerCase() === EXEMPT_REPO || SHA.test(ref)) return null;
  if (lock === null) return "not an inline SHA and there is no lockfile";
  const entry = lock.workflows.get(wfPath);
  if (entry === undefined) return "this workflow has no entry in actions.lock";
  // subpath actions key by repo root: github/codeql-action/init -> github/codeql-action
  const root = name.split("/").slice(0, 2).join("/");
  // Either key may resolve it: a candidate counts only when this workflow lists
  // it AND the lock holds a resolved commit for it.
  const listed = [normRef(ref), normRef(`${root}@${tag}`)].filter((c) => entry.has(c));
  if (listed.length === 0) return "not listed under this workflow in actions.lock";
  if (!listed.some((c) => LOCK_COMMIT.test(lock.deps.get(c) ?? ""))) {
    return "actions.lock has no resolved sha1 commit for it";
  }
  return null;
}

function loadLock() {
  if (!existsSync(LOCK)) {
    console.log("no lockfile — every ref must be an inline 40-character SHA");
    return null;
  }
  const lock = parseLock(readFileSync(LOCK, "utf8"));
  console.log(
    `lockfile present: ${lock.workflows.size} workflow(s), ${lock.deps.size} resolved ref(s)`,
  );
  return lock;
}

// Every unpinned ref in one workflow file, as `file:line: ref (reason)`.
function unpinnedIn(file, lock) {
  const wf = join(WF, file);
  const bad = [];
  for (const { line, ref, why } of declaredRefs(readFileSync(wf, "utf8"))) {
    if (why !== undefined) {
      bad.push(`${wf}:${line + 1}: ${why}`);
      continue;
    }
    const reason = unpinnedReason(ref, `${WF}/${file}`, lock);
    if (reason !== null) bad.push(`${wf}:${line + 1}: ${ref} (${reason})`);
  }
  return bad;
}

function main() {
  if (!existsSync(WF)) {
    console.log("no .github/workflows — nothing to check");
    return 0;
  }
  const lock = loadLock();
  const bad = workflowFiles().flatMap((file) => unpinnedIn(file, lock));
  if (bad.length) {
    console.log("\nERROR: these action refs are neither SHA-pinned nor resolved by the lockfile:");
    for (const b of bad) console.log(`  ${b}`);
    console.log("\nEither pin to a full commit SHA, or run `gh actions-lock` so the");
    console.log("lockfile resolves the ref for that workflow.");
    return 1;
  }
  console.log("all action refs are pinned");
  return 0;
}

process.exit(main());

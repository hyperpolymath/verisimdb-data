#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// build-site.mjs — GitHub Pages publisher for verisimdb-data.
//
// Replaces the retired Jekyll pipeline (`ruby/setup-ruby` + `bundle exec jekyll
// build`, and the `actions/jekyll-build-pages` container build). Ruby is a banned
// implementation language for this estate, so the site is produced by this script.
//
// Runtime: Bun (tier 1 per LANGUAGE-POLICY §1) or Node >= 18, whichever is on
// PATH. Zero dependencies: no lockfile is introduced, so runtime-policy.yml has
// no package-manager tier to police and nothing here needs vendoring.
//
// Usage:
//   bun  scripts/build-site.mjs [--config site.json] [--out _site] [--baseurl PATH]
//   node scripts/build-site.mjs --dry-run
//
// Contract:
//   * Only paths named in site.json reach the site root. The repository tree is
//     never mirrored — the old Jekyll build did exactly that as a side effect,
//     which put scan payloads on a public origin without anyone deciding to.
//   * Output is deterministic for a given input tree + baseurl (no timestamps,
//     sorted entries, LF separators), so CI can prove reproducibility.
//   * Fails closed: a missing `required: true` source is an error. Serving
//     /.well-known/security.txt is a contractual obligation (RFC 9116, RSR).
//   * Symlinks are never published, so the allowlist cannot become a
//     read-any-file primitive.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = resolve(dirname(dirname(realpathSync(argv[1] ?? import.meta.url.pathname))));

// ── CLI ───────────────────────────────────────────────────────────────

function parseArgs(raw) {
  const opts = { config: "site.json", out: null, baseurl: "", dryRun: false };
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--config") opts.config = raw[++i] ?? opts.config;
    else if (arg === "--out") opts.out = raw[++i];
    else if (arg === "--baseurl") opts.baseurl = raw[++i] ?? "";
    else fail(`unknown argument: ${arg}`);
  }
  return opts;
}

function fail(message) {
  stderr.write(`build-site: ${message}\n`);
  exit(1);
}

// ── config ────────────────────────────────────────────────────────────

function loadConfig(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return fail(`cannot read config ${path}: ${err.message}`);
  }
  for (const key of ["title", "output", "copy"]) {
    if (parsed[key] === undefined) fail(`config ${path}: missing "${key}"`);
  }
  if (!Array.isArray(parsed.copy) || parsed.copy.length === 0) {
    fail(`config ${path}: "copy" must be a non-empty array`);
  }
  // A bare string is the shape a person reaches for first ("copy": ["data"]),
  // so it means "publish this to the site root" rather than a stack trace; any
  // other shape is reported as the config error it is.
  parsed.copy = parsed.copy.map((entry, i) => {
    if (typeof entry === "string") return { from: entry, to: "." };
    if (entry !== null && typeof entry === "object" && entry.from !== undefined) return entry;
    return fail(`config copy[${i}]: expected a string or {from,to}, got ${JSON.stringify(entry)}`);
  });
  for (const entry of parsed.copy) {
    assertRelative(entry.from, "copy.from");
    assertRelative(entry.to ?? "", "copy.to");
  }
  if (parsed.index_page !== undefined) assertRelative(parsed.index_page, "index_page");
  parsed.listing = (parsed.listing ?? []).map((entry, i) =>
    typeof entry === "string" ? { root: entry } : entry,
  );
  for (const entry of parsed.listing) {
    assertRelative(entry.root ?? ".", "listing.root");
    if (!Array.isArray(entry.match) || entry.match.length === 0) {
      fail(`config: listing entry for "${entry.root}" needs a non-empty "match" array`);
    }
    if (entry.link_target !== "source" && entry.link_target !== "repo") {
      fail(`config: listing entry for "${entry.root}" needs link_target "source" or "repo"`);
    }
  }
  return parsed;
}

// Anything that could make the publisher read or write outside the repo is a
// config bug, not something to sanitise later: no absolute paths, no "..", no
// globs (list a directory and the walker expands it).
function assertRelative(path, label) {
  if (path === "") return;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    fail(`config ${label}: absolute path "${path}" is not allowed`);
  }
  const parts = path.split(/[\\/]/);
  if (parts.includes("..")) fail(`config ${label}: path traversal in "${path}" is not allowed`);
  if (parts.some((part) => part.includes("*"))) {
    fail(`config ${label}: globs are not supported ("${path}")`);
  }
}

// ── filesystem helpers ────────────────────────────────────────────────

function walk(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip, the plan/verify steps re-check
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue; // never descend into .git or the output dir
      const abs = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) files.push(abs);
    }
  }
  return files.map(toPosixAbs).sort();
}

function toPosixAbs(abs) {
  return abs.slice(ROOT.length + 1).split(sep).join(posix.sep);
}

// Directory names that are never descended into: VCS state, installed
// dependencies, and the site output itself (walking _site while writing _site
// is how a "publish everything" build turns into a fixed point that never ends).
const SKIP = new Set([".git", "node_modules", "target", "_site", ".venv"]);

function byteSize(relPath) {
  try {
    return statSync(resolve(ROOT, relPath)).size;
  } catch {
    return 0;
  }
}

function joinSite(dest, sub) {
  const prefix = dest === undefined || dest === "" || dest === "." ? "" : dest;
  return prefix === "" ? sub : posix.join(prefix, sub);
}

function esc(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function urlFor(baseurl, sitePath) {
  const clean = String(sitePath).replace(/^\.\/?/, "");
  if (clean === "" || clean === ".") return baseurl === "" ? "/" : `${baseurl}/`;
  return baseurl === "" ? `/${clean}` : `${baseurl}/${clean}`;
}

function normaliseBaseurl(raw) {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (value === "" || value === "/") return "";
  const candidate = value.startsWith("/") ? value : `/${value}`;
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(candidate)) fail(`refusing unsafe baseurl: ${raw}`);
  return candidate;
}

// ── build plan ────────────────────────────────────────────────────────

// copy: verbatim trees/files from site.json.
function planCopies(config) {
  const items = [];
  for (const entry of config.copy ?? []) {
    const srcAbs = resolve(ROOT, entry.from);
    if (!existsSync(srcAbs)) {
      if (entry.required) fail(`required publish source missing: ${entry.from}`);
      stdout.write(`build-site: optional source absent, skipped: ${entry.from}\n`);
      continue;
    }
    const stat = lstatSync(srcAbs);
    if (stat.isSymbolicLink()) fail(`publish source is a symlink: ${entry.from}`);
    if (stat.isFile()) {
      // For a single file, `to` is the destination path itself (empty/"."
      // means "same name at the site root").
      const dest = entry.to === undefined || entry.to === "" || entry.to === "."
        ? basename(entry.from)
        : entry.to;
      items.push({ src: entry.from, site: dest });
      continue;
    }
    for (const file of walk(srcAbs)) {
      const sub = file.slice(entry.from.length + 1);
      items.push({ src: file, site: joinSite(entry.to, sub) });
    }
  }
  return items;
}

// listing: index sections. link_target "source" also publishes the file,
// link_target "repo" links to the repository browser and publishes nothing.
function planListings(config) {
  const sections = [];
  const published = [];
  for (const entry of config.listing ?? []) {
    const root = entry.root ?? ".";
    const rootAbs = resolve(ROOT, root);
    if (!existsSync(rootAbs)) {
      stdout.write(`build-site: listing root absent, skipped: ${root}\n`);
      continue;
    }
    const items = walk(rootAbs)
      .filter((file) => entry.match.some((ext) => file.endsWith(ext)))
      .map((file) => ({
        src: file,
        // Keep the tree shape under the listing root; flattening basenames
        // collides the moment two directories both hold a README.
        site: joinSite(root, root === "." ? file : file.slice(root.length + 1)),
      }));
    if (entry.link_target === "source") published.push(...items);
    sections.push({ label: entry.label ?? root, linkTarget: entry.link_target, items });
  }
  return { sections, published };
}

function dedupe(items) {
  const bySite = new Map();
  for (const item of items) {
    const existing = bySite.get(item.site);
    if (existing !== undefined && existing.src !== item.src) {
      fail(`collision: "${item.src}" and "${existing.src}" both publish to /${item.site}`);
    }
    bySite.set(item.site, item);
  }
  return [...bySite.values()].sort((a, b) => (a.site < b.site ? -1 : 1));
}

// ── build ─────────────────────────────────────────────────────────────

function build(opts) {
  const config = loadConfig(resolve(ROOT, opts.config));
  const outDir = resolve(ROOT, opts.out ?? config.output);
  const baseurl = normaliseBaseurl(opts.baseurl);
  SKIP.add(basename(outDir));

  const listings = planListings(config);
  const published = dedupe([...planCopies(config), ...listings.published]);

  const outputs = new Map();
  for (const item of published) outputs.set(item.site, readFileSync(resolve(ROOT, item.src)));

  const manifest = published.map((item) => ({ path: item.site, source: item.src, bytes: byteSize(item.src) }));
  // The hub page is deliberately NOT at the site root: GitHub Pages serves
  // index.json for '/' here, and a root index.html would take that over and
  // change the content type of a machine-readable endpoint.
  const indexPage = config.index_page === undefined ? "hub/index.html" : config.index_page;
  const atRoot = published.find((item) => item.site === "index.html");
  if (atRoot !== undefined && indexPage !== "index.html") {
    fail(
      `"${atRoot.src}" would publish to /index.html and take over '/' (this site's root is ` +
        `index.json). Publish it under a directory, or set "index_page": "index.html" to say ` +
        `you really mean it. CI guards this too, so failing here is the earlier, kinder half.`,
    );
  }
  if (indexPage !== "") {
    outputs.set(indexPage, Buffer.from(renderIndex({ config, baseurl, sections: listings.sections, manifest }), "utf8"));
  }
  outputs.set(
    "publish-manifest.json",
    Buffer.from(`${JSON.stringify({ generator: "scripts/build-site.mjs", baseurl: baseurl || "/", files: manifest }, null, 2)}\n`, "utf8"),
  );
  if (config.nojekyll !== false) outputs.set(".nojekyll", Buffer.from("\n", "utf8"));

  const hash = createHash("sha256");
  for (const site of [...outputs.keys()].sort()) {
    hash.update(`${site}\u0000`);
    hash.update(outputs.get(site));
    hash.update("\n");
  }
  const digest = hash.digest("hex");
  stdout.write(
    `build-site: ${outputs.size} files, ${published.length} sources copied, baseurl="${baseurl || "/"}", sha256=${digest}\n`,
  );

  if (opts.dryRun) {
    stdout.write("build-site: --dry-run, nothing written\n");
    return { outDir, outputs, digest, published };
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [site, buffer] of outputs) writeSiteFile(outDir, site, buffer);
  stdout.write(`build-site: wrote ${outDir.split(sep).join(posix.sep)}\n`);
  return { outDir, outputs, digest, published };
}

function writeSiteFile(outDir, site, buffer) {
  if (site.includes("..")) fail(`refusing site path with traversal: ${site}`);
  const dest = join(outDir, site);
  const parent = dirname(dest);
  mkdirSync(parent, { recursive: true });
  const realRoot = realpathSync(outDir);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    fail(`refusing to write outside the site root: ${site}`);
  }
  writeFileSync(dest, buffer);
}

// ── html ──────────────────────────────────────────────────────────────

function repoUrl(src) {
  const slug = env.GITHUB_REPOSITORY ?? "hyperpolymath/verisimdb-data";
  const ref = env.GITHUB_REF_NAME ?? "main";
  return `https://github.com/${slug}/blob/${ref}/${src.split("/").map(encodeURIComponent).join("/")}`;
}

function renderIndex({ config, baseurl, sections, manifest }) {
  const blocks = [];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    const rows = section.items.map((item) => {
      const href = section.linkTarget === "repo" ? repoUrl(item.src) : urlFor(baseurl, item.site);
      return `        <li><a href="${esc(href)}">${esc(item.src)}</a></li>`;
    });
    blocks.push(`      <section id="${esc(slugify(section.label))}">
        <h2>${esc(section.label)}</h2>
        <ul>
${rows.join("\n")}
        </ul>
      </section>`);
  }
  blocks.push(`      <section id="published-files">
        <h2>Published files (first 200 of ${manifest.length}; full list in <code>publish-manifest.json</code>)</h2>
        <ul>
${manifest.slice(0, 200).map((item) => `        <li><code>${esc(item.path)}</code> <span>${item.bytes} B</span></li>`).join("\n")}
        </ul>
      </section>`);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(config.title)}</title>
    <meta name="generator" content="scripts/build-site.mjs" />
    <link rel="alternate" type="application/json" href="${esc(urlFor(baseurl, "publish-manifest.json"))}" />
    <style>
      :root { color-scheme: light dark; }
      body { font: 16px/1.55 system-ui, sans-serif; margin: 0 auto; max-width: 62rem;
             padding: 2rem 1.25rem 4rem; }
      header { border-bottom: 1px solid currentColor; padding-bottom: 1rem; margin-bottom: 1.5rem; }
      h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
      h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
      p.lead { margin: 0; opacity: .8; }
      ul { list-style: none; margin: 0; padding: 0; columns: 2; }
      li { padding: .1rem 0; break-inside: avoid; }
      li span { opacity: .6; font-size: .85em; }
      code { font-family: ui-monospace, monospace; }
      footer { margin-top: 3rem; border-top: 1px solid currentColor; padding-top: 1rem;
               opacity: .75; font-size: .85rem; }
      @media (max-width: 40rem) { ul { columns: 1; } }
    </style>
  </head>
  <body>
    <header>
      <h1>${esc(config.title)}</h1>
      <p class="lead">
        Flat-file data store for VeriSimDB scan, drift and outcome records.
        Built by <code>scripts/build-site.mjs</code> (Bun / Node — no Ruby, no Jekyll)
        from the publish allowlist in <code>site.json</code>.
      </p>
    </header>
${blocks.join("\n")}
    <footer>
      <p>
        The canonical dataset is the git tree, not this site. Machine-readable index:
        <a href="${esc(urlFor(baseurl, "index.json"))}"><code>index.json</code></a>.
        Security contacts: <a href="${esc(urlFor(baseurl, ".well-known/security.txt"))}">security.txt</a>.
      </p>
    </footer>
  </body>
</html>
`;
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) build(parseArgs(argv.slice(2)));

export { build, dedupe, normaliseBaseurl, parseArgs, planCopies, planListings, urlFor, walk };

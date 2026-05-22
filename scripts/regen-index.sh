#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
#
# regen-index.sh — rebuild index.json from scans/ on disk.
#
# Deterministic: output depends only on the contents of scans/ and on
# git history (for the last_updated timestamp). Running this script
# twice in a row produces byte-identical output.
#
# Used by:
#   * scripts/ingest-scan.sh (after appending a new scan)
#   * .github/workflows/index-freshness.yml (CI lane that fails if the
#     committed index drifts from what this script produces).
#
# Schema (matches the historical shape):
#   {
#     "last_updated": "<ISO-8601, commit time of the latest scans/ change>",
#     "total_scans":   <int — count of top-level *.json files in scans/>,
#     "total_repos":   <int — same as total_scans; one repo per file>,
#     "repos":         [ "<basename without .json>", … sorted ]
#   }
#
# Subdirectories under scans/ (e.g. scans/octads/) are intentionally
# excluded from `repos` / `total_scans`. They are conceptually a
# different space; if a separate index is needed for them, file a
# follow-up issue.

set -euo pipefail

SCAN_DIR="${SCAN_DIR:-scans}"
OUT="${OUT:-index.json}"

cd "$(git rev-parse --show-toplevel)"

if [[ ! -d "$SCAN_DIR" ]]; then
  echo "regen-index: $SCAN_DIR/ not found" >&2
  exit 1
fi

# Determine last_updated deterministically: ISO-8601 commit time of the
# latest commit that touched scans/. Falls back to epoch if there is no
# such commit yet (e.g. on a fresh clone before any scan landed).
last_updated="$(git log -1 --format=%cI -- "$SCAN_DIR" 2>/dev/null || true)"
if [[ -z "${last_updated}" ]]; then
  last_updated="1970-01-01T00:00:00+00:00"
fi

# Collect top-level *.json files, strip extension, sort.
mapfile -t repos < <(
  find "$SCAN_DIR" -maxdepth 1 -mindepth 1 -type f -name '*.json' -printf '%f\n' \
    | sed -E 's/\.json$//' \
    | LC_ALL=C sort -u
)

total_scans=${#repos[@]}

# Build repos JSON array via jq (handles edge cases: empty, special chars).
repos_json="$(printf '%s\n' "${repos[@]:-}" | jq -R -s -c 'split("\n") | map(select(length > 0))')"

# Compose final JSON. `--sort-keys` keeps output stable.
jq -n --sort-keys \
  --arg last_updated "$last_updated" \
  --argjson total_scans "$total_scans" \
  --argjson total_repos "$total_scans" \
  --argjson repos "$repos_json" \
  '{
    last_updated: $last_updated,
    total_scans: $total_scans,
    total_repos: $total_repos,
    repos: $repos
  }' > "$OUT.tmp"

# Atomic replace.
mv "$OUT.tmp" "$OUT"

echo "regen-index: wrote $OUT — $total_scans scans, last_updated=$last_updated"

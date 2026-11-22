#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Manual scan ingestion helper for verisimdb-data
# Usage: ./scripts/ingest-scan.sh <repo-name> <scan-result.json>
#
# Updates: scans/ and patterns/registry.json, then rebuilds index.json
# with scripts/regen-index.sh after the commit.

set -euo pipefail

REPO_NAME="${1:-}"
SCAN_FILE="${2:-}"
NO_COMMIT=false
[[ "${3:-}" == "--no-commit" ]] && NO_COMMIT=true

if [[ -z "$REPO_NAME" || -z "$SCAN_FILE" ]]; then
    echo "Usage: $0 <repo-name> <scan-result.json> [--no-commit]"
    echo
    echo "Example:"
    echo "  cd ~/Documents/hyperpolymath-repos/echidna"
    echo "  panic-attack assail . --output /tmp/echidna-scan.json"
    echo "  cd ~/Documents/hyperpolymath-repos/verisimdb-data"
    echo "  ./scripts/ingest-scan.sh echidna /tmp/echidna-scan.json"
    exit 1
fi

if [[ ! -f "$SCAN_FILE" ]]; then
    echo "Error: Scan file not found: $SCAN_FILE"
    exit 1
fi

# One scan file per repo name: no empty, path-like, hidden or multi-line
# names (regen-index.sh lists scans one per line).
case "$REPO_NAME" in
    ''|*/*|.*|*$'\n'*|*$'\r'*) echo "Error: invalid repo name"; exit 1 ;;
    *) ;;  # any other name is accepted
esac

# Get repository root
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# regen-index.sh reads scans/ from disk, so any other uncommitted scan
# would land in index.json without being in the commit. Refuse that.
if [ "$NO_COMMIT" = "false" ]; then
    OTHER_SCAN_CHANGES=$(git status --porcelain --untracked-files=all -- scans/ \
        | awk -v f="scans/${REPO_NAME}.json" 'substr($0, 4) != f')
    if [[ -n "$OTHER_SCAN_CHANGES" ]]; then
        echo "Error: scans/ has other uncommitted changes:"
        printf '%s\n' "$OTHER_SCAN_CHANGES"
        echo "Commit or remove them first, or use --no-commit."
        exit 1
    fi
fi

echo "Ingesting scan for $REPO_NAME..."

# Copy scan result
cp "$SCAN_FILE" "scans/${REPO_NAME}.json"
echo "  Copied scan to scans/${REPO_NAME}.json"

SCAN_DATA=$(cat "scans/${REPO_NAME}.json")
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# index.json is owned by scripts/regen-index.sh. Its last_updated is the
# commit time of the latest scans/ commit, so it is rebuilt after the
# commit below, not here.

# Update pattern registry from scan weak_points
REGISTRY_FILE="patterns/registry.json"
SUBSTITUTIONS_FILE="recipes/proven-substitutions.json"

if [[ -f "$REGISTRY_FILE" && -f "$SUBSTITUTIONS_FILE" ]]; then
    # Extract unique (category, description) pairs and update registry
    jq --arg repo "$REPO_NAME" \
       --arg time "$TIMESTAMP" \
       --slurpfile subs "$SUBSTITUTIONS_FILE" \
       --argjson scan_data "$SCAN_DATA" \
    '
    # Build a lookup from PA category to substitution info
    ($subs[0].substitutions | map({(.category): .}) | add) as $sub_lookup |

    # Process each weak point from the scan
    reduce ($scan_data.weak_points // [] | to_entries[]) as $entry (
      .;
      $entry.value as $wp |
      ($wp.category // "unknown") as $cat |
      ($wp.description // $wp.category // "unknown") as $desc |

      # Build pattern ID from category
      # Map known categories to PA rule numbers
      (if $cat == "UncheckedAllocation" then "PA001"
       elif $cat == "UnboundedLoop" then "PA002"
       elif $cat == "BlockingIO" then "PA003"
       elif $cat == "UnsafeCode" then "PA004"
       elif $cat == "PanicPath" then "PA005"
       elif $cat == "RaceCondition" then "PA006"
       elif $cat == "DeadlockPotential" then "PA007"
       elif $cat == "ResourceLeak" then "PA008"
       elif $cat == "CommandInjection" then "PA009"
       elif $cat == "UnsafeDeserialization" then "PA010"
       elif $cat == "DynamicCodeExecution" then "PA011"
       elif $cat == "UnsafeFFI" then "PA012"
       elif $cat == "AtomExhaustion" then "PA013"
       elif $cat == "InsecureProtocol" then "PA014"
       elif $cat == "ExcessivePermissions" then "PA015"
       elif $cat == "PathTraversal" then "PA016"
       elif $cat == "HardcodedSecret" then "PA017"
       elif $cat == "UncheckedError" then "PA018"
       elif $cat == "InfiniteRecursion" then "PA019"
       elif $cat == "UnsafeTypeCoercion" then "PA020"
       else "PA000" end) as $pa_rule |

      # Generate a short description slug
      ($desc | gsub("[^a-zA-Z0-9]"; "-") | gsub("-+"; "-") | .[0:30] | ascii_downcase) as $slug |
      ($pa_rule + "-" + $slug) as $pattern_id |

      # Get triangle tier from substitutions lookup
      (($sub_lookup[$cat] // {}).triangle_tier // "control") as $tier |

      # Update or create pattern entry
      if .patterns[$pattern_id] then
        .patterns[$pattern_id].occurrences += 1 |
        .patterns[$pattern_id].last_seen = $time |
        (if (.patterns[$pattern_id].repos_affected_list | index($repo)) == null
         then .patterns[$pattern_id].repos_affected += 1 |
              .patterns[$pattern_id].repos_affected_list += [$repo]
         else . end)
      else
        .patterns[$pattern_id] = {
          id: $pattern_id,
          category: $cat,
          severity: ($wp.severity // "Medium"),
          description: $desc,
          pa_rule: $pa_rule,
          occurrences: 1,
          repos_affected: 1,
          repos_affected_list: [$repo],
          first_seen: $time,
          last_seen: $time,
          trend: "new",
          triangle_tier: $tier,
          recipe_id: null
        }
      end
    ) |
    .last_updated = $time
    ' "$REGISTRY_FILE" > "${REGISTRY_FILE}.tmp" && mv "${REGISTRY_FILE}.tmp" "$REGISTRY_FILE"

    echo "  Updated pattern registry"
fi

# Show summary
WEAK_COUNT=$(jq '.weak_points | length' "scans/${REPO_NAME}.json")
PATTERN_COUNT=$(jq --arg repo "$REPO_NAME" \
  '[.patterns | to_entries[] | select(.value.repos_affected_list | index($repo))] | length' \
  "$REGISTRY_FILE" 2>/dev/null || echo 0)

echo "  Found $WEAK_COUNT weak points in $REPO_NAME ($PATTERN_COUNT unique patterns)"

# Commit (unless --no-commit)
if [ "$NO_COMMIT" = "false" ]; then
    git add "scans/${REPO_NAME}.json" patterns/ recipes/ outcomes/
    git commit -m "scan: update ${REPO_NAME} results"
    # Rebuild index.json from the commit that now holds the scan, then fold
    # it into that commit. Keeping the committer date keeps last_updated
    # equal to what regen-index.sh computes for the final commit.
    bash scripts/regen-index.sh
    git add index.json
    GIT_COMMITTER_DATE="$(git log -1 --format=%cd --date=raw)" \
        git commit --amend --no-edit --allow-empty
    echo "  Committed changes"
else
    echo "  Skipped commit (--no-commit)"
    echo "  After committing scans/, rebuild and fold in index.json:"
    echo "    bash scripts/regen-index.sh && git add index.json"
    echo '    GIT_COMMITTER_DATE="$(git log -1 --format=%cd --date=raw)" git commit --amend --no-edit --allow-empty'
fi
echo
echo "Next steps:"
echo "  git push"
echo "  git push gitlab main"

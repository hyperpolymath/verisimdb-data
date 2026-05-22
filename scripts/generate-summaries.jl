#!/usr/bin/env julia
# SPDX-License-Identifier: MPL-2.0
# Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
#
# generate-summaries.jl - Auto-generate summary fields for repos in index.json
#
# Reads each scan file in scans/ and builds a concise summary string from:
#   - weak point count and severity breakdown
#   - top categories of weak points
#   - detected language
#   - scan timestamp from index.json
#
# Usage: julia scripts/generate-summaries.jl [--dry-run]

using JSON3
using Dates

const REPO_ROOT = dirname(dirname(abspath(@__FILE__)))
const INDEX_PATH = joinpath(REPO_ROOT, "index.json")
const SCANS_DIR = joinpath(REPO_ROOT, "scans")

# Severity ordering for "top severity" reporting
const SEVERITY_ORDER = Dict(
    "Critical" => 4,
    "High"     => 3,
    "Medium"   => 2,
    "Low"      => 1
)

"""
    build_summary(repo_name, scan_data, index_entry) -> String

Build a concise summary string from scan data and index entry.

Format examples:
  "71 weak points (8 High, 58 Medium, 5 Low); top: PanicPath (30), CommandInjection (25); lang: rust"
  "0 weak points; clean scan; lang: elixir"
  "16 weak points (3 Critical, 12 Medium, 1 Low); top: UnsafeCode (8), PanicPath (5); lang: idris2"
"""
function build_summary(repo_name::AbstractString, scan_data::Dict, index_entry::Dict)::String
    weak_points = get(scan_data, "weak_points", [])
    wp_count = length(weak_points)
    language = get(scan_data, "language", "unknown")
    last_scan = get(index_entry, "last_scan", "unknown")

    # Extract just the date portion from the ISO timestamp
    scan_date = try
        string(last_scan)[1:10]
    catch
        "unknown"
    end

    if wp_count == 0
        return "0 weak points; clean scan; lang: $(language); scanned: $(scan_date)"
    end

    # Severity breakdown
    severities = Dict{String,Int}()
    for wp in weak_points
        sev = get(wp, "severity", "Unknown")
        severities[sev] = get(severities, sev, 0) + 1
    end
    sorted_sevs = sort(collect(keys(severities));
                       by = s -> get(SEVERITY_ORDER, s, 0), rev = true)
    sev_parts = ["$(severities[s]) $(s)" for s in sorted_sevs]
    sev_str = join(sev_parts, ", ")

    # Top categories (up to 3)
    categories = Dict{String,Int}()
    for wp in weak_points
        cat = get(wp, "category", "Unknown")
        categories[cat] = get(categories, cat, 0) + 1
    end
    sorted_cats = sort(collect(pairs(categories)); by = p -> p.second, rev = true)
    top_cats = sorted_cats[1:min(3, length(sorted_cats))]
    cat_parts = ["$(cat) ($(count))" for (cat, count) in top_cats]
    cat_str = join(cat_parts, ", ")

    return "$(wp_count) weak points ($(sev_str)); top: $(cat_str); lang: $(language); scanned: $(scan_date)"
end

"""
    main() -> Int

Main entry point. Returns 0 on success, 1 if errors occurred.
"""
function main()::Int
    dry_run = "--dry-run" in ARGS

    # Load index
    index = JSON3.read(read(INDEX_PATH, String)) |> Dict
    repos_raw = get(index, "repos", Dict())
    repos = Dict(string(k) => Dict(string(k2) => v2 for (k2, v2) in pairs(v))
                 for (k, v) in pairs(repos_raw))

    updated_count = 0
    skipped_count = 0
    error_count = 0

    for repo_name in sort(collect(keys(repos)))
        entry = repos[repo_name]

        # Only update NULL summaries
        if get(entry, "summary", nothing) !== nothing
            skipped_count += 1
            continue
        end

        scan_file = joinpath(SCANS_DIR, "$(repo_name).json")
        if !isfile(scan_file)
            println("  SKIP (no scan file): $(repo_name)")
            skipped_count += 1
            continue
        end

        local scan_data::Dict
        try
            raw = JSON3.read(read(scan_file, String))
            scan_data = Dict(string(k) => begin
                v_inner = raw[k]
                if v_inner isa JSON3.Array
                    [Dict(string(k2) => v2 for (k2, v2) in pairs(item)) for item in v_inner]
                else
                    v_inner
                end
            end for k in keys(raw))
        catch e
            println("  ERROR reading $(scan_file): $(e)")
            error_count += 1
            continue
        end

        summary = build_summary(repo_name, scan_data, entry)
        entry["summary"] = summary
        updated_count += 1

        if dry_run
            println("  $(repo_name): $(summary)")
        end
    end

    # Update repos back into index and set timestamp
    index["repos"] = repos
    index["last_updated"] = Dates.format(now(Dates.UTC), "yyyy-mm-ddTHH:MM:SS+00:00")

    if !dry_run
        # Write updated index
        open(INDEX_PATH, "w") do f
            JSON3.pretty(f, index)
            write(f, "\n")
        end
        println("Updated index.json")
    end

    println("\nResults: $(updated_count) summaries generated, $(skipped_count) skipped, $(error_count) errors")
    return error_count == 0 ? 0 : 1
end

exit(main())

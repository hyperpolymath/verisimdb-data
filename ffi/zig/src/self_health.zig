// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// verisimdb-data :: ffi/zig/src/self_health.zig
//
// Self-health persistence: verisimdb-data reporting its own ingestion
// health back to the VeriSimDB REST API instance it feeds.
//
// This closes the observability loop:
//
//   panic-attack → verisimdb-data (git) → VeriSimDB REST → Hypatia
//                             ↑                               |
//                             └───── self_health report ──────┘
//
// When VeriSimDB REST is running (http://localhost:8080), verisimdb-data
// can report its own ingest statistics (scan count, last ingest timestamp,
// repo coverage) so Hypatia rules can detect pipeline staleness.
//
// ## Collection: verisimdb-data:pipeline-health
//
// ```json
// {
//   "check_id":      "vdd:1740000000000",
//   "timestamp":     "2026-01-30T12:00:00Z",
//   "total_scans":   301,
//   "total_repos":   5,
//   "last_ingest":   "2026-03-07T22:19:01Z",
//   "status":        "healthy"
// }
// ```
//
// ## Usage
//
// Call `reportPipelineHealth` after every ingest to keep VeriSimDB REST
// current. Returns an error on connectivity failure — caller should log
// and continue (fail-open semantics).

const std = @import("std");

const DEFAULT_URL  = "http://localhost:8080";
const COLLECTION   = "verisimdb-data:pipeline-health";

/// Pipeline health snapshot for self-reporting.
pub const PipelineHealth = struct {
    check_id:    []const u8,
    timestamp:   []const u8,
    total_scans: u32,
    total_repos: u32,
    last_ingest: []const u8,
    status:      []const u8,
};

/// Report pipeline health to VeriSimDB REST.
///
/// This is called after every scan ingestion to keep the VeriSimDB
/// pipeline-health collection current. Fail-open: connectivity errors
/// are returned but do not abort the ingest.
pub fn reportPipelineHealth(allocator: std.mem.Allocator, health: PipelineHealth) !void {
    const base_url = std.posix.getenv("VERISIMDB_URL") orelse DEFAULT_URL;

    const url = try std.fmt.allocPrint(allocator, "{s}/v1/{s}/{s}", .{
        base_url, COLLECTION, health.check_id,
    });
    defer allocator.free(url);

    const body = try std.fmt.allocPrint(allocator,
        \\{{
        \\  "check_id": "{s}",
        \\  "timestamp": "{s}",
        \\  "total_scans": {d},
        \\  "total_repos": {d},
        \\  "last_ingest": "{s}",
        \\  "status": "{s}"
        \\}}
    , .{
        health.check_id,
        health.timestamp,
        health.total_scans,
        health.total_repos,
        health.last_ingest,
        health.status,
    });
    defer allocator.free(body);

    try httpPut(allocator, url, body);
}

/// Generate a health check ID from the current timestamp.
///
/// Format: `vdd:<ts_ms>`
pub fn makeCheckId(allocator: std.mem.Allocator, ts_ms: u64) ![]u8 {
    return std.fmt.allocPrint(allocator, "vdd:{d}", .{ts_ms});
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn httpPut(allocator: std.mem.Allocator, url: []const u8, body: []const u8) !void {
    var client = std.http.Client{ .allocator = allocator };
    defer client.deinit();

    const uri = try std.Uri.parse(url);

    var header_buf: [4096]u8 = undefined;
    var req = try client.open(.PUT, uri, .{
        .server_header_buffer = &header_buf,
        .extra_headers = &.{
            .{ .name = "Content-Type", .value = "application/json" },
        },
    });
    defer req.deinit();

    req.transfer_encoding = .{ .content_length = body.len };
    try req.send();
    try req.writeAll(body);
    try req.finish();
    try req.wait();

    const status = req.response.status;
    if (@intFromEnum(status) < 200 or @intFromEnum(status) >= 300) {
        return error.VeriSimDbHttpError;
    }
}

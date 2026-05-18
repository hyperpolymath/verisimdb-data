// VERISIMDB_DATA FFI Implementation
//
// This module implements the C-compatible FFI declared in src/abi/Foreign.idr
// All types and layouts must match the Idris2 ABI definitions.
//
// SPDX-License-Identifier: PMPL-1.0-or-later

const std = @import("std");

// Version information (keep in sync with project)
const VERSION = "0.1.0";
const BUILD_INFO = "VERISIMDB_DATA built with Zig " ++ @import("builtin").zig_version_string;

/// Thread-local error storage
threadlocal var last_error: ?[]const u8 = null;

/// Set the last error message
fn setError(msg: []const u8) void {
    last_error = msg;
}

/// Clear the last error
fn clearError() void {
    last_error = null;
}

//==============================================================================
// Core Types (must match src/abi/Types.idr)
//==============================================================================

/// Result codes (must match Idris2 Result type)
pub const Result = enum(c_int) {
    ok = 0,
    @"error" = 1,
    invalid_param = 2,
    out_of_memory = 3,
    null_pointer = 4,
};

/// Library handle. A plain struct on the Zig side; C consumers only ever
/// hold it behind `?*Handle` and never dereference it, so it stays opaque
/// across the ABI. (The template declared this `opaque` *with fields*,
/// which is a compile error — fixed as part of de-stubbing for #6.)
pub const Handle = struct {
    allocator: std.mem.Allocator,
    initialized: bool,
};

//==============================================================================
// Library Lifecycle
//==============================================================================

/// Initialize the library
/// Returns a handle, or null on failure
export fn verisimdb_data_init() ?*Handle {
    const allocator = std.heap.c_allocator;

    const handle = allocator.create(Handle) catch {
        setError("Failed to allocate handle");
        return null;
    };

    // Initialize handle
    handle.* = .{
        .allocator = allocator,
        .initialized = true,
    };

    clearError();
    return handle;
}

/// Free the library handle
export fn verisimdb_data_free(handle: ?*Handle) void {
    const h = handle orelse return;
    const allocator = h.allocator;

    // Clean up resources
    h.initialized = false;

    allocator.destroy(h);
    clearError();
}

//==============================================================================
// Core Operations
//==============================================================================

/// Process data (example operation)
export fn verisimdb_data_process(handle: ?*Handle, input: u32) Result {
    const h = handle orelse {
        setError("Null handle");
        return .null_pointer;
    };

    if (!h.initialized) {
        setError("Handle not initialized");
        return .@"error";
    }

    // Example processing logic
    _ = input;

    clearError();
    return .ok;
}

//==============================================================================
// String Operations
//==============================================================================

/// Get a string result (example)
/// Caller must free the returned string
export fn verisimdb_data_get_string(handle: ?*Handle) ?[*:0]const u8 {
    const h = handle orelse {
        setError("Null handle");
        return null;
    };

    if (!h.initialized) {
        setError("Handle not initialized");
        return null;
    }

    // Example: allocate and return a string
    const result = h.allocator.dupeZ(u8, "Example result") catch {
        setError("Failed to allocate string");
        return null;
    };

    clearError();
    return result.ptr;
}

/// Free a string allocated by the library
export fn verisimdb_data_free_string(str: ?[*:0]const u8) void {
    const s = str orelse return;
    const allocator = std.heap.c_allocator;

    const slice = std.mem.span(s);
    allocator.free(slice);
}

//==============================================================================
// Array/Buffer Operations
//==============================================================================

/// Process an array of data
export fn verisimdb_data_process_array(
    handle: ?*Handle,
    buffer: ?[*]const u8,
    len: u32,
) Result {
    const h = handle orelse {
        setError("Null handle");
        return .null_pointer;
    };

    const buf = buffer orelse {
        setError("Null buffer");
        return .null_pointer;
    };

    if (!h.initialized) {
        setError("Handle not initialized");
        return .@"error";
    }

    // Access the buffer
    const data = buf[0..len];
    _ = data;

    // Process data here

    clearError();
    return .ok;
}

//==============================================================================
// Error Handling
//==============================================================================

/// Get the last error message
/// Returns null if no error
export fn verisimdb_data_last_error() ?[*:0]const u8 {
    const err = last_error orelse return null;

    // Return C string (static storage, no need to free)
    const allocator = std.heap.c_allocator;
    const c_str = allocator.dupeZ(u8, err) catch return null;
    return c_str.ptr;
}

//==============================================================================
// Version Information
//==============================================================================

/// Get the library version
export fn verisimdb_data_version() [*:0]const u8 {
    return VERSION.ptr;
}

/// Get build information
export fn verisimdb_data_build_info() [*:0]const u8 {
    return BUILD_INFO.ptr;
}

//==============================================================================
// Callback Support
//==============================================================================

/// Callback function type (C ABI)
pub const Callback = *const fn (u64, u32) callconv(.c) u32;

/// Register a callback
export fn verisimdb_data_register_callback(
    handle: ?*Handle,
    callback: ?Callback,
) Result {
    const h = handle orelse {
        setError("Null handle");
        return .null_pointer;
    };

    const cb = callback orelse {
        setError("Null callback");
        return .null_pointer;
    };

    if (!h.initialized) {
        setError("Handle not initialized");
        return .@"error";
    }

    // Store callback for later use
    _ = cb;

    clearError();
    return .ok;
}

//==============================================================================
// Utility Functions
//==============================================================================

/// Check if handle is initialized
export fn verisimdb_data_is_initialized(handle: ?*Handle) u32 {
    const h = handle orelse return 0;
    return if (h.initialized) 1 else 0;
}

//==============================================================================
// Octad ABI (#6, V-L3-N1)
//
// The verisimdb octad has eight dimensions. `OctadDimension` carries the
// per-dimension presence byte; `ProvenanceEntry` mirrors the octad
// `provenance` block (a 64-bit content hash plus NUL-padded tool/version
// identifiers). Both are `extern struct` so the C ABI / layout is stable
// across the FFI boundary, and each has a wire encode/decode pair so a
// consumer can prove a lossless round-trip.
//==============================================================================

/// Eight octad dimension presence bytes (0 = absent, 1 = present).
pub const OctadDimension = extern struct {
    data: u8,
    metadata: u8,
    provenance: u8,
    lineage: u8,
    constraints: u8,
    access_control: u8,
    temporal: u8,
    simulation: u8,
};

pub const OCTAD_WIRE_LEN: usize = 8;

/// Serialize an `OctadDimension` (8 bytes, dimension order). Returns the
/// number of bytes written, or -1 on a null/short-buffer error.
export fn verisimdb_data_octad_encode(
    in: ?*const OctadDimension,
    out: ?[*]u8,
    cap: usize,
) isize {
    const d = in orelse return -1;
    const o = out orelse return -1;
    if (cap < OCTAD_WIRE_LEN) return -1;
    const src = std.mem.asBytes(d);
    @memcpy(o[0..OCTAD_WIRE_LEN], src[0..OCTAD_WIRE_LEN]);
    return @intCast(OCTAD_WIRE_LEN);
}

/// Deserialize an `OctadDimension` from `buf`.
export fn verisimdb_data_octad_decode(
    buf: ?[*]const u8,
    len: usize,
    out: ?*OctadDimension,
) Result {
    const b = buf orelse return .null_pointer;
    const o = out orelse return .null_pointer;
    if (len < OCTAD_WIRE_LEN) return .invalid_param;
    const dst = std.mem.asBytes(o);
    @memcpy(dst[0..OCTAD_WIRE_LEN], b[0..OCTAD_WIRE_LEN]);
    return .ok;
}

/// One provenance record: a content hash plus NUL-padded identifiers.
pub const ProvenanceEntry = extern struct {
    hash: u64,
    tool: [32]u8,
    version: [16]u8,
};

/// hash (8, little-endian) + tool (32) + version (16).
pub const PROVENANCE_WIRE_LEN: usize = 8 + 32 + 16;

/// Serialize a `ProvenanceEntry`. Returns bytes written or -1.
export fn verisimdb_data_provenance_encode(
    in: ?*const ProvenanceEntry,
    out: ?[*]u8,
    cap: usize,
) isize {
    const e = in orelse return -1;
    const o = out orelse return -1;
    if (cap < PROVENANCE_WIRE_LEN) return -1;
    std.mem.writeInt(u64, o[0..8], e.hash, .little);
    @memcpy(o[8..40], &e.tool);
    @memcpy(o[40..56], &e.version);
    return @intCast(PROVENANCE_WIRE_LEN);
}

/// Deserialize a `ProvenanceEntry` from `buf`.
export fn verisimdb_data_provenance_decode(
    buf: ?[*]const u8,
    len: usize,
    out: ?*ProvenanceEntry,
) Result {
    const b = buf orelse return .null_pointer;
    const e = out orelse return .null_pointer;
    if (len < PROVENANCE_WIRE_LEN) return .invalid_param;
    e.hash = std.mem.readInt(u64, b[0..8], .little);
    @memcpy(&e.tool, b[8..40]);
    @memcpy(&e.version, b[40..56]);
    return .ok;
}

//==============================================================================
// Tests
//==============================================================================

test "lifecycle" {
    const handle = verisimdb_data_init() orelse return error.InitFailed;
    defer verisimdb_data_free(handle);

    try std.testing.expect(verisimdb_data_is_initialized(handle) == 1);
}

test "error handling" {
    const result = verisimdb_data_process(null, 0);
    try std.testing.expectEqual(Result.null_pointer, result);

    const err = verisimdb_data_last_error();
    try std.testing.expect(err != null);
}

test "version" {
    const ver = verisimdb_data_version();
    const ver_str = std.mem.span(ver);
    try std.testing.expectEqualStrings(VERSION, ver_str);
}

test "octad dimension round-trip is lossless" {
    const in = OctadDimension{
        .data = 1,
        .metadata = 1,
        .provenance = 1,
        .lineage = 0,
        .constraints = 1,
        .access_control = 0,
        .temporal = 1,
        .simulation = 0,
    };
    var buf: [OCTAD_WIRE_LEN]u8 = undefined;
    const n = verisimdb_data_octad_encode(&in, &buf, buf.len);
    try std.testing.expectEqual(@as(isize, @intCast(OCTAD_WIRE_LEN)), n);

    var out: OctadDimension = undefined;
    try std.testing.expectEqual(Result.ok, verisimdb_data_octad_decode(&buf, buf.len, &out));
    try std.testing.expectEqual(in, out);
}

test "octad encode rejects a short buffer" {
    const in = std.mem.zeroes(OctadDimension);
    var small: [3]u8 = undefined;
    try std.testing.expectEqual(@as(isize, -1), verisimdb_data_octad_encode(&in, &small, small.len));
}

test "provenance entry round-trip is lossless" {
    var in = std.mem.zeroes(ProvenanceEntry);
    in.hash = 0xDEAD_BEEF_CAFE_F00D;
    @memcpy(in.tool[0..7], "verisim");
    @memcpy(in.version[0..5], "0.1.0");

    var buf: [PROVENANCE_WIRE_LEN]u8 = undefined;
    const n = verisimdb_data_provenance_encode(&in, &buf, buf.len);
    try std.testing.expectEqual(@as(isize, @intCast(PROVENANCE_WIRE_LEN)), n);

    var out: ProvenanceEntry = undefined;
    try std.testing.expectEqual(
        Result.ok,
        verisimdb_data_provenance_decode(&buf, buf.len, &out),
    );
    try std.testing.expectEqual(in.hash, out.hash);
    try std.testing.expectEqualSlices(u8, &in.tool, &out.tool);
    try std.testing.expectEqualSlices(u8, &in.version, &out.version);
}

test "provenance decode rejects a short buffer" {
    var out: ProvenanceEntry = undefined;
    var short: [10]u8 = undefined;
    try std.testing.expectEqual(
        Result.invalid_param,
        verisimdb_data_provenance_decode(&short, short.len, &out),
    );
}

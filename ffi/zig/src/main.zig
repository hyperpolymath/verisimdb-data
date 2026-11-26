// VERISIMDB_DATA FFI Implementation
//
// This module implements the C-compatible FFI declared in src/abi/Foreign.idr
// All types and layouts must match the Idris2 ABI definitions.
//
// SPDX-License-Identifier: MPL-2.0

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

/// Library handle (opaque to C callers; the state lives in `State`).
/// Zig forbids fields on `opaque`, so the handle is an opaque pointer to a
/// private, Zig-only state struct.
pub const Handle = opaque {};

const State = struct {
    allocator: std.mem.Allocator,
    initialized: bool,
};

fn stateOf(h: *Handle) *State {
    return @ptrCast(@alignCast(h));
}

//==============================================================================
// Library Lifecycle
//==============================================================================

/// Initialize the library
/// Returns a handle, or null on failure
export fn verisimdb_data_init() ?*Handle {
    const allocator = std.heap.c_allocator;

    const state = allocator.create(State) catch {
        setError("Failed to allocate handle");
        return null;
    };

    state.* = .{
        .allocator = allocator,
        .initialized = true,
    };

    clearError();
    return @ptrCast(state);
}

/// Free the library handle
export fn verisimdb_data_free(handle: ?*Handle) void {
    const h = handle orelse return;
    const state = stateOf(h);
    const allocator = state.allocator;

    state.initialized = false;

    allocator.destroy(state);
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

    if (!stateOf(h).initialized) {
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

    if (!stateOf(h).initialized) {
        setError("Handle not initialized");
        return null;
    }

    // Example: allocate and return a string
    const result = stateOf(h).allocator.dupeZ(u8, "Example result") catch {
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

    if (!stateOf(h).initialized) {
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

    if (!stateOf(h).initialized) {
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
    return if (stateOf(h).initialized) 1 else 0;
}

//==============================================================================
// Wire format: OctadDimension and ProvenanceEntry
//==============================================================================
//
// Fixed-size, byte-oriented encodings used to move these records across the
// FFI boundary without sharing struct layout assumptions.
//
//   OctadDimension  (8 bytes):  the eight u8 fields in declaration order.
//   ProvenanceEntry (56 bytes): hash as u64 little-endian (8), tool (32),
//                               version (16).
//
// Encoders return the number of bytes written, or -1 on a null argument or a
// buffer shorter than the wire length (nothing is written in that case).
// Decoders return Result.invalid_param for a buffer shorter than the wire
// length and Result.null_pointer for a null argument.

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

pub const ProvenanceEntry = extern struct {
    hash: u64,
    tool: [32]u8,
    version: [16]u8,
};

pub const OCTAD_WIRE_LEN: usize = 8;
pub const PROVENANCE_WIRE_LEN: usize = 8 + 32 + 16;

export fn verisimdb_data_octad_encode(
    src: ?*const OctadDimension,
    out: ?[*]u8,
    cap: usize,
) isize {
    const s = src orelse {
        setError("Null octad");
        return -1;
    };
    const o = out orelse {
        setError("Null output buffer");
        return -1;
    };
    if (cap < OCTAD_WIRE_LEN) {
        setError("Output buffer too small for octad");
        return -1;
    }
    o[0] = s.data;
    o[1] = s.metadata;
    o[2] = s.provenance;
    o[3] = s.lineage;
    o[4] = s.constraints;
    o[5] = s.access_control;
    o[6] = s.temporal;
    o[7] = s.simulation;
    clearError();
    return @intCast(OCTAD_WIRE_LEN);
}

export fn verisimdb_data_octad_decode(
    in: ?[*]const u8,
    len: usize,
    out: ?*OctadDimension,
) Result {
    const i = in orelse {
        setError("Null input buffer");
        return .null_pointer;
    };
    const d = out orelse {
        setError("Null octad");
        return .null_pointer;
    };
    if (len < OCTAD_WIRE_LEN) {
        setError("Input buffer too small for octad");
        return .invalid_param;
    }
    d.* = .{
        .data = i[0],
        .metadata = i[1],
        .provenance = i[2],
        .lineage = i[3],
        .constraints = i[4],
        .access_control = i[5],
        .temporal = i[6],
        .simulation = i[7],
    };
    clearError();
    return .ok;
}

export fn verisimdb_data_provenance_encode(
    src: ?*const ProvenanceEntry,
    out: ?[*]u8,
    cap: usize,
) isize {
    const s = src orelse {
        setError("Null provenance entry");
        return -1;
    };
    const o = out orelse {
        setError("Null output buffer");
        return -1;
    };
    if (cap < PROVENANCE_WIRE_LEN) {
        setError("Output buffer too small for provenance entry");
        return -1;
    }
    std.mem.writeInt(u64, o[0..8], s.hash, .little);
    @memcpy(o[8..40], &s.tool);
    @memcpy(o[40..56], &s.version);
    clearError();
    return @intCast(PROVENANCE_WIRE_LEN);
}

export fn verisimdb_data_provenance_decode(
    in: ?[*]const u8,
    len: usize,
    out: ?*ProvenanceEntry,
) Result {
    const i = in orelse {
        setError("Null input buffer");
        return .null_pointer;
    };
    const p = out orelse {
        setError("Null provenance entry");
        return .null_pointer;
    };
    if (len < PROVENANCE_WIRE_LEN) {
        setError("Input buffer too small for provenance entry");
        return .invalid_param;
    }
    p.hash = std.mem.readInt(u64, i[0..8], .little);
    @memcpy(&p.tool, i[8..40]);
    @memcpy(&p.version, i[40..56]);
    clearError();
    return .ok;
}

//==============================================================================
// Tests
//==============================================================================

test "octad wire round-trip and rejection paths" {
    const in = OctadDimension{
        .data = 1,
        .metadata = 2,
        .provenance = 3,
        .lineage = 4,
        .constraints = 5,
        .access_control = 6,
        .temporal = 7,
        .simulation = 8,
    };
    var buf: [OCTAD_WIRE_LEN]u8 = undefined;
    try std.testing.expectEqual(@as(isize, 8), verisimdb_data_octad_encode(&in, &buf, buf.len));
    // Wire order is the declaration order: pins the format, not just symmetry.
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3, 4, 5, 6, 7, 8 }, &buf);

    var out: OctadDimension = undefined;
    try std.testing.expectEqual(Result.ok, verisimdb_data_octad_decode(&buf, buf.len, &out));
    try std.testing.expect(std.meta.eql(in, out));

    var tiny: [3]u8 = undefined;
    try std.testing.expectEqual(@as(isize, -1), verisimdb_data_octad_encode(&in, &tiny, tiny.len));
    try std.testing.expectEqual(@as(isize, -1), verisimdb_data_octad_encode(null, &buf, buf.len));
    try std.testing.expectEqual(Result.invalid_param, verisimdb_data_octad_decode(&buf, 7, &out));
    try std.testing.expectEqual(Result.null_pointer, verisimdb_data_octad_decode(null, buf.len, &out));
    try std.testing.expectEqual(Result.null_pointer, verisimdb_data_octad_decode(&buf, buf.len, null));
}

test "provenance wire round-trip and rejection paths" {
    var in = std.mem.zeroes(ProvenanceEntry);
    in.hash = 0x0102_0304_0506_0708;
    @memcpy(in.tool[0..7], "verisim");
    @memcpy(in.version[0..5], "0.1.0");

    var buf: [PROVENANCE_WIRE_LEN]u8 = undefined;
    try std.testing.expectEqual(@as(isize, 56), verisimdb_data_provenance_encode(&in, &buf, buf.len));
    // Little-endian hash first: pins the byte order.
    try std.testing.expectEqualSlices(u8, &.{ 8, 7, 6, 5, 4, 3, 2, 1 }, buf[0..8]);

    var out: ProvenanceEntry = undefined;
    try std.testing.expectEqual(Result.ok, verisimdb_data_provenance_decode(&buf, buf.len, &out));
    try std.testing.expectEqual(in.hash, out.hash);
    try std.testing.expectEqualSlices(u8, &in.tool, &out.tool);
    try std.testing.expectEqualSlices(u8, &in.version, &out.version);

    var tiny: [55]u8 = undefined;
    try std.testing.expectEqual(@as(isize, -1), verisimdb_data_provenance_encode(&in, &tiny, tiny.len));
    try std.testing.expectEqual(Result.invalid_param, verisimdb_data_provenance_decode(&buf, 55, &out));
}

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

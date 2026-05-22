// verisimdb-data FFI consumer demo
// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// #6 (V-L3-N1). A standalone executable that LINKS the Zig FFI static
// library (build.zig: `consumer.linkLibrary(lib)`) and drives the
// C-ABI contract from the outside — proving the OctadDimension and
// ProvenanceEntry layouts and encode/decode functions round-trip
// losslessly across the FFI boundary. Exits 0 on success, 1 on any
// mismatch; prints a one-line PASS/FAIL summary.
//
// Replaces the old test/integration_test.zig, which was an
// uncompilable `{{project}}` template stub (it could never build).

const std = @import("std");

// Result codes — must match src/main.zig `Result`.
const Result = enum(c_int) {
    ok = 0,
    @"error" = 1,
    invalid_param = 2,
    out_of_memory = 3,
    null_pointer = 4,
};

// Layouts — must match the `extern struct`s in src/main.zig.
const OctadDimension = extern struct {
    data: u8,
    metadata: u8,
    provenance: u8,
    lineage: u8,
    constraints: u8,
    access_control: u8,
    temporal: u8,
    simulation: u8,
};

const ProvenanceEntry = extern struct {
    hash: u64,
    tool: [32]u8,
    version: [16]u8,
};

const OCTAD_WIRE_LEN: usize = 8;
const PROVENANCE_WIRE_LEN: usize = 8 + 32 + 16;

// Symbols resolved from the linked FFI library.
extern fn verisimdb_data_octad_encode(*const OctadDimension, [*]u8, usize) isize;
extern fn verisimdb_data_octad_decode([*]const u8, usize, *OctadDimension) Result;
extern fn verisimdb_data_provenance_encode(*const ProvenanceEntry, [*]u8, usize) isize;
extern fn verisimdb_data_provenance_decode([*]const u8, usize, *ProvenanceEntry) Result;
extern fn verisimdb_data_version() [*:0]const u8;

pub fn main() void {

    // --- OctadDimension round-trip ---
    const octad_in = OctadDimension{
        .data = 1,
        .metadata = 1,
        .provenance = 1,
        .lineage = 0,
        .constraints = 1,
        .access_control = 0,
        .temporal = 1,
        .simulation = 0,
    };
    var octad_buf: [OCTAD_WIRE_LEN]u8 = undefined;
    const on = verisimdb_data_octad_encode(&octad_in, &octad_buf, octad_buf.len);
    if (on != @as(isize, @intCast(OCTAD_WIRE_LEN))) {
        std.debug.print("FAIL: octad encode returned {d}\n", .{on});
        std.process.exit(1);
    }
    var octad_out: OctadDimension = undefined;
    if (verisimdb_data_octad_decode(&octad_buf, octad_buf.len, &octad_out) != .ok) {
        std.debug.print("FAIL: octad decode returned non-ok\n", .{});
        std.process.exit(1);
    }
    if (!std.meta.eql(octad_in, octad_out)) {
        std.debug.print("FAIL: octad round-trip mismatch\n", .{});
        std.process.exit(1);
    }

    // --- ProvenanceEntry round-trip ---
    var prov_in = std.mem.zeroes(ProvenanceEntry);
    prov_in.hash = 0xDEAD_BEEF_CAFE_F00D;
    @memcpy(prov_in.tool[0..7], "verisim");
    @memcpy(prov_in.version[0..5], "0.1.0");

    var prov_buf: [PROVENANCE_WIRE_LEN]u8 = undefined;
    const pn = verisimdb_data_provenance_encode(&prov_in, &prov_buf, prov_buf.len);
    if (pn != @as(isize, @intCast(PROVENANCE_WIRE_LEN))) {
        std.debug.print("FAIL: provenance encode returned {d}\n", .{pn});
        std.process.exit(1);
    }
    var prov_out: ProvenanceEntry = undefined;
    if (verisimdb_data_provenance_decode(&prov_buf, prov_buf.len, &prov_out) != .ok) {
        std.debug.print("FAIL: provenance decode returned non-ok\n", .{});
        std.process.exit(1);
    }
    if (prov_in.hash != prov_out.hash or
        !std.mem.eql(u8, &prov_in.tool, &prov_out.tool) or
        !std.mem.eql(u8, &prov_in.version, &prov_out.version))
    {
        std.debug.print("FAIL: provenance round-trip mismatch\n", .{});
        std.process.exit(1);
    }

    // --- Negative path: short buffer must be rejected, not corrupt memory ---
    var tiny: [3]u8 = undefined;
    if (verisimdb_data_octad_encode(&octad_in, &tiny, tiny.len) != -1) {
        std.debug.print("FAIL: short-buffer octad encode was not rejected\n", .{});
        std.process.exit(1);
    }

    const ver = std.mem.span(verisimdb_data_version());
    std.debug.print(
        "PASS: verisimdb-data FFI v{s} — OctadDimension + ProvenanceEntry round-trip OK\n",
        .{ver},
    );
}

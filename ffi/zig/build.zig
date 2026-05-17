// verisimdb-data FFI build configuration
// SPDX-License-Identifier: PMPL-1.0-or-later
// Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Zig 0.15.x. De-templated from the {{PROJECT}} skeleton (#6, V-L3-N1):
// the old build referenced a nonexistent header/bench/docs and the
// pre-0.14 addSharedLibrary API. This builds the FFI as a static
// library, runs the in-source unit tests, and builds + runs a consumer
// that links the library and exercises the OctadDimension +
// ProvenanceEntry round-trip.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addLibrary(.{
        .name = "verisimdb_data",
        .linkage = .static,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    b.installArtifact(lib);

    // In-source unit tests (src/main.zig `test { ... }` blocks).
    const lib_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    const run_lib_tests = b.addRunArtifact(lib_tests);
    const test_step = b.step("test", "Run FFI unit tests");
    test_step.dependOn(&run_lib_tests.step);

    // Consumer demo: a standalone executable that LINKS the FFI library
    // (proving the C-ABI contract) and round-trips OctadDimension +
    // ProvenanceEntry through the exported encode/decode functions.
    const consumer = b.addExecutable(.{
        .name = "octad_consumer",
        .root_module = b.createModule(.{
            .root_source_file = b.path("test/octad_consumer.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    consumer.linkLibrary(lib);
    b.installArtifact(consumer);

    const run_consumer = b.addRunArtifact(consumer);
    const consumer_step = b.step("consumer", "Build + run the FFI consumer round-trip demo");
    consumer_step.dependOn(&run_consumer.step);

    // `zig build check` = unit tests + consumer (the CI entry point).
    const check_step = b.step("check", "Unit tests + consumer round-trip (CI gate)");
    check_step.dependOn(&run_lib_tests.step);
    check_step.dependOn(&run_consumer.step);
}

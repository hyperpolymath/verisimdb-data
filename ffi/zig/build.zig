// SPDX-License-Identifier: MPL-2.0
// Zig 0.15 build for the verisimdb-data FFI library.
//
//   zig build         static + dynamic library
//   zig build test    unit tests (src/main.zig, src/self_health.zig)
//   zig build check   unit tests plus the C-ABI round-trip consumer
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

    const static_lib = b.addLibrary(.{
        .name = "verisimdb_data",
        .linkage = .static,
        .root_module = lib_mod,
    });
    b.installArtifact(static_lib);

    const shared_lib = b.addLibrary(.{
        .name = "verisimdb_data",
        .linkage = .dynamic,
        .root_module = lib_mod,
    });
    b.installArtifact(shared_lib);

    // Unit tests.
    const test_step = b.step("test", "Run unit tests");
    for ([_][]const u8{ "src/main.zig", "src/self_health.zig" }) |path| {
        const t = b.addTest(.{
            .root_module = b.createModule(.{
                .root_source_file = b.path(path),
                .target = target,
                .optimize = optimize,
                .link_libc = true,
            }),
        });
        test_step.dependOn(&b.addRunArtifact(t).step);
    }

    // Round-trip consumer: a separate executable that reaches the library only
    // through its exported C ABI, so a symbol or layout break fails the build.
    const consumer = b.addExecutable(.{
        .name = "octad_consumer",
        .root_module = b.createModule(.{
            .root_source_file = b.path("test/octad_consumer.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    consumer.root_module.linkLibrary(static_lib);

    const check_step = b.step("check", "Unit tests plus the round-trip consumer");
    check_step.dependOn(test_step);
    check_step.dependOn(&b.addRunArtifact(consumer).step);
}

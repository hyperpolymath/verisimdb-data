<!--
SPDX-License-Identifier: MPL-2.0
Copyright (c) Jonathan D.A. Jewell <j.d.a.jewell@open.ac.uk>
-->
# TEST-NEEDS.md — verisimdb-data

## CRG Grade: C — ACHIEVED 2026-04-04

## Current Test State

| Category | Count | Notes |
|----------|-------|-------|
| Zig FFI tests | 1 | `ffi/zig/test/integration_test.zig` |
| Scorecard CI recipes | 1 | `recipes/recipe-scorecard-ci-tests.json` |
| Scan definitions | 3 | Broad spectrum, proven repos, verified containers |

## What's Covered

- [x] Zig FFI integration tests
- [x] Scorecard test recipes
- [x] Scan specifications for verification

## Still Missing (for CRG B+)

- [ ] Data validation tests
- [ ] Database query tests
- [ ] Replication tests
- [ ] Performance benchmarks
- [ ] Data consistency tests

## Run Tests

```bash
cd /var/mnt/eclipse/repos/verisimdb-data && cargo test
```

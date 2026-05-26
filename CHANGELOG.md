<!--
SPDX-License-Identifier: MPL-2.0
SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath)
-->

# Changelog

All notable changes to `verisimdb-data` will be documented in this file.

This file is generated from conventional commits by the
[`changelog-reusable.yml`](https://github.com/hyperpolymath/standards/blob/main/.github/workflows/changelog-reusable.yml)
workflow (`hyperpolymath/standards#206`). Adopt the workflow in this repo's CI to keep this file in sync automatically — see
[`templates/cliff.toml`](https://github.com/hyperpolymath/standards/blob/main/templates/cliff.toml)
for the canonical config.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- feat(crg): add crg-grade and crg-badge justfile recipes
- feat: add self-health VeriSimDB Zig module to close observability loop
- feat: migrate generate-summaries from Python to Julia
- feat: add stapeln.toml container definition
- feat: add UX Justfile with doctor, tour, help-me, assail recipes
- feat: deploy UX Manifesto infrastructure
- feat: initialize verisimdb-data as standalone repo

### Fixed

- fix(ci): Phase-2 fleet submission must not fail the security gate (#9)
- fix(ci): hypatia-scan workdir (${{ env.HOME }} resolves empty) (#8)

### Documentation

- docs: add M2 estate audit report (2026-04-04)
- docs: add TOPOLOGY.md
- docs: add TEST-NEEDS.md (CRG C)
- docs: add EXPLAINME.adoc — prove-it file backing README claims

### CI

- ci: bump actions/upload-artifact SHA to current v4 (#3)
- ci: SHA-pin hyperpolymath validate-actions in dogfood-gate
- ci: fix workflow-linter YAML parse error + self-flag bug
- ci: restore Dependabot security path + wire auto-merge
- ci: deploy dogfood-gate, fix hypatia-scan, add pre-commit hooks

## Pre-history

Prior commits to this file's introduction are recorded in git history but not formally classified into Keep-a-Changelog sections. To backfill, run `git cliff -o CHANGELOG.md` locally using the canonical [`cliff.toml`](https://github.com/hyperpolymath/standards/blob/main/templates/cliff.toml) — this is one-shot mechanical work.

---

<!-- This file was seeded by the 2026-05-26 estate tech-debt audit follow-up (Row-2 Phase 3); see [`hyperpolymath/standards/docs/audits/2026-05-26-estate-documentation-debt.md`](https://github.com/hyperpolymath/standards/blob/main/docs/audits/2026-05-26-estate-documentation-debt.md). -->

<!-- SPDX-License-Identifier: PMPL-1.0-or-later -->
<!-- Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk> -->

# TOPOLOGY.md — verisimdb-data

## Purpose

VeriSimDB Data Repository is a git-backed flat-file storage system for scan results and drift detection data. Receives panic-attack scan results, hardware-crash-team findings, and drift detection snapshots via GitHub Actions workflow_dispatch events. Maintains master index and enables historical analysis of repository health and compliance drift over time.

## Module Map

```
verisimdb-data/
├── scans/               # panic-attack scan results per repo
├── hardware/            # hardware-crash-team findings
├── drift/               # drift detection snapshots
├── index.json           # Master index of all stored data
└── .github/workflows/   # Ingest workflows (receive results)
```

## Data Flow

```
[Workflow Dispatch] ──► [Ingest Handler] ──► [JSON Validation] ──► [File Storage]
                                                    ↓
                                            [Index Update] ──► [Query Ready]
```

## Integration Points

- **panic-attack**: Upstream scanner sending results
- **hardware-crash-team**: Hardware failure analysis
- **Drift detection**: Compliance change tracking
- **Hyperpolymath CI/CD**: Automated data aggregation

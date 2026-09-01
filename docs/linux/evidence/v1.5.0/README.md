# v1.5.0 production evidence

This directory is intentionally an evidence template. It must contain retained
outputs from a disposable Ubuntu 24.04 x86_64 VM before a release note claims
production readiness.

Required artifacts:

- package SHA-256 manifest and exact source/tag commit;
- `ACCEPTANCE_SUMMARY.md` describing clean install, upgrade, rollback,
  uninstall, reinstall, service owner, and tunnel evidence;
- clean install, upgrade, rollback, uninstall, and reinstall transcript;
- XDG state preservation hash and non-root service owner proof;
- secret-canary scan covering stdout, logs, SQLite, task metadata, and reports;
- tunnel reconnect/health evidence; and
- a bounded soak TSV from `scripts/soak-linux-headless.sh` with start/end
  system state and reviewed RSS, file-descriptor, WAL, task, and restart data.

The release workflow refuses every `v1.5.*` tag until either the retained
production evidence exists and the default verifier accepts the TSV, or an
explicit `SEVEN_DAY_SOAK_WAIVER.md` is present. A waiver is a transparent
non-production release path: it must state `SEVEN_DAY_SOAK_GATE: WAIVED` and
`PRODUCTION_EVIDENCE_CLAIM: NONE` and never implies a completed soak.

Validate the retained TSV before review:

```sh
bash scripts/verify-soak-linux-headless.sh path/to/soak-linux-headless.tsv
```

The verifier requires two or more samples, a seven-day minimum duration by
default, a stable process owner, and bounded RSS, file-descriptor, and WAL
growth. Set `SOAK_MIN_DURATION_SECONDS` only for a disposable smoke check; a
short run cannot satisfy the production evidence gate.

No seven-day soak is claimed until an operator places the completed files here.

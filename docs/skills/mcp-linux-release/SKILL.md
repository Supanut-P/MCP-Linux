---
name: mcp-linux-release
description: Prepare and verify Baitonghub Linux MCP release candidates against the exact source, Ubuntu package, contract, and acceptance gates.
---

# MCP Linux release

Treat Ubuntu 24.04 x86_64 as the release authority. Bind evidence to the exact source commit and package hashes. Run the full source gates, branding check, generated catalog and v1 contract checks, acceptance suite, packaging, and `git diff --check`; then run the packaged install/smoke and upgrade/rollback checks on Ubuntu 24.04. Use the repository's [Ubuntu acceptance](../../linux/UBUNTU_ACCEPTANCE.md), [release checklist](../../../.github/RELEASE_CHECKLIST.md), [release workflow](../../../.github/workflows/release.yml), and [package scripts](../../../package.json) for the current commands. Do not infer Ubuntu acceptance from another host.

Confirm the contract, catalog, package contents, checksums, provenance/SBOM, rollback evidence, and release notes for the candidate. A seven-day soak waiver is not soak evidence or production readiness; describe the waiver accurately. Record exact commands, exit codes, source/package hashes, artifact paths, and what each check establishes.

Only carry out a release action when that exact action and target payload were approved. Stop for the user before creating branches, changing production credentials, destructive operations, external deploys, merges, pushes, tags, or publishing. Do not install skill bundles or alter machine-global configuration.

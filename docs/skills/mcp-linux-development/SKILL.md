---
name: mcp-linux-development
description: Implement or change Baitonghub Linux MCP code and docs with scoped edits, bounded worker help, and repo-specific verification.
---

# MCP Linux development

Use `Scope -> Edit -> Verify -> Report`. Preserve existing dirty work; inspect status and diffs before editing, and do not overwrite unrelated changes. Keep trivial work local with the smallest relevant lead check. For nontrivial work, define acceptance and verification first, then follow the version roadmap in order: a milestone is not complete until its Ubuntu gate passes, and do not skip that gate to start the next version.

When the user or applicable instructions authorize multi-agent work, use a fresh, bounded worker context for independent implementation tasks and a separate Sol review for independent QA. Keep a single writer per file; parallelize only known disjoint scopes. Maximum topology is four agents total, depth one. Use Astra only to resolve material architecture ambiguity. Model presets: Astra low for architecture; Sol 6.1 medium for lead; Luna low/medium for bounded implementation; Sol medium/high for risk-based QA. Give a worker at most two Luna attempts including the first, then one Sol attempt; if still blocked, stop and replan. Context targets: 32 KiB worker, 64 KiB QA, 2 KiB handoff. Continue in a fresh context as needed; never truncate mandatory safety constraints. These are byte/context targets, not a total-token hard cap. Use scripts for deterministic repeated work.

For nontrivial work, leave an auditable receipt with source/diff hashes, exact commands and exit codes, artifact paths, and verification bounds. A local check does not establish Ubuntu, production, or customer acceptance.

Pause for explicit human approval before creating branches, changing production or credentials, destructive operations, external actions, deploys, merges, pushes, tags, or releases.

Relevant repo references: [version roadmap](../../superpowers/plans/2026-09-30-mcp-linux-v2-roadmap.md), [Ubuntu acceptance](../../linux/UBUNTU_ACCEPTANCE.md), [tool contract](../../architecture/TOOL_CONTRACT.md), and [package scripts](../../../package.json).

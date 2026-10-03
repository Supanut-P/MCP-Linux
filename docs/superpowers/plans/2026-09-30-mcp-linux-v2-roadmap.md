# MCP Linux v2 roadmap

**Goal:** deliver a single-user AI Engineer and Linux Ops experience through the Codex subscription, exposed as MCP tools and CLI workflows. Keep v1 compatible while shipping v2 as a gated product milestone. The agent may act autonomously only inside the approved milestone scope and its registered workspace/policy boundaries.

## Current position and sequencing

- v1.37.0 follow-up source/package gates, install/rollback, and installed MCP fleet inspection through native Secret Service/pinned loopback SSH passed on a new clean snapshot after fixing public admin-command routing. The configured test connector was verified running the exact 1.37 candidate; native calls, restart/reconnect, installed-byte binding, and bounded known-credential checks including incident diagnostics passed. That installation is superseded by the accepted v1.38 package below. Independent QA found no remaining material findings and v1.37 milestone verification is closed; publication remains unapproved. See [current candidate evidence](../../harness/evidence/2026-10-01-packaged-fleet.md), [configured tunnel evidence](../../harness/evidence/2026-10-02-configured-tunnel.md), and the separate [historical Ubuntu evidence](../../harness/evidence/2026-09-30-v1.37-ubuntu.md).
- v1.38 verification is closed after independent QA under the [native workflow contract](../../harness/contracts/v1.38-native-workflow.md) and [Ubuntu acceptance receipt](../../harness/evidence/2026-10-03-v1.38-ubuntu.md). The configured VM now runs the source-bound 1.38 package. Publication remains unapproved. v1.39 implementation is active under the [context packet contract](../../harness/contracts/v1.39-context-packets.md), with its acceptance gates still open; later milestones remain planned.
- Work in strict order: complete all gates for a version before starting the next version. A failed gate blocks sequence advancement and triggers bounded repair or replan. P1 work is optional, does not block v2, and reserved version numbers do not imply empty releases.
- Preserve the frozen v1 contract and compatibility throughout v1.x and v2.0. v2 is an additive product milestone, not permission to break v1.

## Release map

| Version | Priority | Outcome and scope | Exit evidence |
| --- | --- | --- | --- |
| 1.37 | P0 closure | Close bounded, redacted `remote_fleet` journal reads across registered hosts. | Complete current candidate gates on Ubuntu 24.04, package evidence, v1 contract/catalog checks, and release record. Until then, do not start 1.38. |
| 1.38 | P0 | Task contracts, role prompts, explicit planner/worker/reviewer handoffs, native subagents, and QA report. | Complete a full native worker plus independent QA round on a bug fix in this repository; contract validation, bounded handoff, cancellation/error paths, and source-linked QA receipt pass. |
| 1.39 | P0 | Compact context packets, content fingerprints, and continuation across turns. | Fingerprints are stable; continuation resolves references and detects stale context without losing safety instructions. |
| 1.40 | P0 | Skill source, version, and hash binding; permission-aware skill selection. | Skill identity is auditable, untrusted skill content cannot override policy, and changed skill hashes invalidate stale receipts. |
| 1.41 | P0 | Codex adapter with role/model/reasoning-effort preflight, structured results, and cancellation. | Provider calls are opt-in and policy checked; errors/results are structured, bounded, and cancellation is honored. |
| 1.42 | P0 | Durable dependency claims, task events, and resume. | SQLite transactions preserve ownership and state; resume does not duplicate side effects; rollback never auto-replays work. |
| 1.43 | P0 | Workspace scope, owner locks, leases, and scoped diffs. | Registered-root and owner boundaries hold under concurrency, expiry, stale leases, and cancellation. |
| 1.44 | P0 | Source-bound QA receipts with bounded retry. | Receipt binds source snapshot, diff, command/exit, artifact hash, reviewer, and verification bounds; retry limits are enforced. |
| 1.45 | P0 | Usage and workflow benchmarks. | Reproducible, source-matched single-agent/routed comparison meets the targets below without pass-rate or safety regression. |
| 1.46 | P0 | Fleet groups and safe host mapping. | Groups resolve only registered host IDs; mapping and partial results are bounded, owner-safe, and auditable. |
| 1.47 | P0 | Incident timeline from journal, metrics, and change events. | Timeline retains source/time/status, redacts sensitive data, and labels gaps and unavailable providers. |
| 1.48 | P0 | Baseline drift states: changed, unavailable, and truncated. | These states remain distinct end-to-end; incomplete evidence cannot be reported as clean or unchanged. |
| 1.49 | P0 | Evidence-linked incident hypotheses and confidence. | Each hypothesis cites source records, explains confidence and missing evidence, and remains a suggestion rather than authority. |
| 1.50 | P0 | Incident-to-local-code-fix workflow with regression evidence. | A code fix stays within the approved workspace; QA receipt ties regression command/result and diff to the incident; no deploy authority. |
| 1.51 | P1 optional | Docker Compose development and deployment rehearsal support. | Isolated rehearsal and cleanup evidence; omission does not block v2. |
| 1.52 | P1 optional | Bounded read-only database diagnostics, query inspection, migration drift, and connection health through registered aliases. | Only registered database aliases and bounded read-only operations are accepted; no query writes or maintenance mutations; omission does not block v2. |
| 1.53 | P1 optional | Deployment rehearsal workflow. | Rehearsal reports preflight, planned changes, health checks, and rollback readiness without production mutation; omission does not block v2. |
| 1.54 | P1 optional | Disposable environment restore drill. | Restore and recovery evidence from disposable state; omission does not block v2. |
| 1.55 | P0 | Security and reliability hardening across the complete v2 path. | Acceptance suite, threat-focused boundary review, dependency audit, concurrency/stale-state coverage, and packaged Linux smoke pass. |
| 1.56 | P0 | Release candidate, compatibility proof, operator docs, and acceptance review. | RC artifacts and evidence are complete; v1 compatibility and v2 workflows pass on supported Ubuntu; known limits and soak status are explicit. |
| 2.0 | P0 gated release | Release the single-user AI Engineer + Linux Ops v2 product after owner actual-use acceptance and explicit human approval. | The owner completes actual-use acceptance; P0 end-to-end coding and incident trials plus live model selection, authentication, cancellation, and resume evidence pass; release/security/package gates pass, v1 compatibility is demonstrated, and a human approves publication. |

## Product and workflow contract

The user-facing workflow is one MCP/CLI product for a single user, backed by the user's Codex subscription. Autonomous execution is allowed within the accepted milestone contract, registered workspace, declared file/dependency scope, and applicable permissions. Production changes, external writes, secret access, deployment, or other separately gated authority remain behind their own human gates.

The workflow API is additive and exposes `workflow.plan`, `workflow.start`, `workflow.status`, `workflow.events`, `workflow.result`, `workflow.resume`, and `workflow.cancel`; `incident.collect`, `incident.status`, and `incident.report`; and optional Codex role/model/reasoning-effort selection. Preserve existing v1 tool shapes and defaults. Validate role/model/effort against adapter capability and policy before dispatch.

Durable workflow states are `planned`, `ready`, `running`, `verifying`, `done`, `blocked`, `failed`, and `cancelled`. Persist state transitions and events transactionally in SQLite with owner/scope binding and recoverable backups. Resume is explicit and reconciles completed steps and dependency claims; restoring a backup or rolling back state must never automatically replay external side effects.

Every task contract declares goal, allowed workspace/files, dependencies, acceptance criteria and commands, roles, context references, and stop conditions. QA receipts bind the source snapshot and diff, verification command and exit status, artifact/hash, reviewer, and verification limits. A receipt cannot claim evidence beyond what its source and command actually establish.

## Context and agent operating limits

Application-managed context targets are 32 KiB per worker, 64 KiB for QA, and 2 KiB per handoff. These are context-packet budgets, not total model-token caps. Never truncate or omit safety policy, scope, stop conditions, or required verification to meet a budget. Pass bounded relevant snippets or deltas and resolve stable references on demand. Load skills lazily; retain full logs and artifacts outside prompts and link them by stable reference and hash. Report actual provider token counts when available; use `null` when unavailable. Do not infer token counts from bytes.

Use this default role workflow:

- Sol 6.1, medium reasoning: lead, scope and integration.
- Luna, low or medium: bounded worker tasks.
- Sol, medium or high: independent QA review.
- Astra, low reasoning: only for genuinely uncertain architecture decisions.

At most four agents run in total, with delegation depth one. Keep one writer per shared scope unless file scopes are disjoint. Changes to shared schemas, the package lockfile, and generated files are serialized. Small, deterministic tasks stay with the lead. For a task that remains blocked, allow two Luna attempts including the initial attempt, then one Sol attempt; if still blocked, stop for a replan instead of looping.

## Durable local skills

Route to existing provided development skills where applicable, and add exactly three repo-local `SKILL.md` entrypoints: development, incident, and release. Each entrypoint documents its bounded workflow, required evidence, stop conditions, and relevant existing commands/docs. Skill source, version, and content hash are recorded with the task/receipt. Skills provide workflow guidance and never grant permissions.

## Benchmark and acceptance contract

Benchmark six fixed, reviewable fixtures: small edit, bug fix, refactor, context continuation, incident triage, and incident resume. Compare a single-agent run with the routed workflow using identical source inputs, acceptance criteria, and verification commands. Record pass/fail, actual total provider tokens when available (otherwise `null`), latency, retries, and safety-boundary outcomes. Treat at least 25% lower median total actual tokens for routed runs as an experimental improvement objective, with no acceptance pass-rate regression and zero safety failures. If the objective is missed, tune the preset or reduce the topology and retain the measured failure; do not claim token savings. Do not translate bytes to tokens or omit failed runs from the comparison.

Acceptance must exercise coding, refactoring, recovery, concurrent work, stale context, skill injection, partial incident data, incident-to-patch boundaries, security, and package installation/use. Use synthetic or disposable fixtures where mutation is required. Each release requires unit, integration, packaging, release-contract, documentation, and Ubuntu smoke evidence. A waived soak is recorded as waived, never passed.

## Backlog after v2

Potential follow-on work, outside the v2 release gate: graph views; flaky-test diagnosis; performance and architecture analysis; capacity, certificate-expiry inspection, dependency, and maintenance workflows; reusable templates; replay; skill scoring; cross-repository flows; dashboards and team notifications; ARM64 and additional distributions; and opt-in adapters for other providers. These do not expand authority or block v2. Prioritize only from observed user needs and separately gated proposals.

## Self-review and status rules

This is a plan, not implementation evidence. Do not mark a version complete from this roadmap. Record implementation, local checks, Ubuntu/package acceptance, release artifacts, compatibility results, and human approval separately. Maintain the strict sequence and stop at the first failed gate. No release or external mutation is authorized by this document.




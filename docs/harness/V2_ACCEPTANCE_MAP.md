# v2 acceptance evidence map

Technical verification is closed under the [v2 receipt](evidence/2026-10-04-v2.0.0-ubuntu.md).
It binds 807 frozen source files, 87 current artifacts and 180 revalidated
historical artifact bindings. The approved test VM runs 2.0.0.
Seven Windows and twenty Ubuntu gates passed; v1 contracts remain compatible.
Owner milestone delivery and Git push are approved; personal trial results
remain unreported. Publication was separately approved and completed under the
[publication receipt](evidence/2026-10-04-roadmap-publication.md).

The compatible promotion changes version metadata/documentation only.
Historical native proofs keep their original source, inputs and execution time;
459 package src files are byte-identical to the closed v1.56 snapshot and the
shared constant differs only by version. Current v2 package/native replay is
separate. Closure documentation is codified after the frozen artifact snapshot.

| Scenario | Verified technical evidence and boundary |
| --- | --- |
| Coding | Real v1.38 repo bugfix round and v1.56 native worker mirror patch, baseline-checked integration, regression and independent QA. Exact code fingerprints carried to v2; current v2 source gates and authenticated installed calls replayed. Literal native v2 calls execute no tools. |
| Refactoring | v1.56 executable paired refactor fixture preserves behavior and checks actual fixture results; historical inputs retained. Current v2 full unit/v1 acceptance replayed. Updated v2 guidance was not benchmarked. |
| Recovery | Current installed STDIO/HTTP workflow restart preserves claims, rejects duplicate starts and retains receipts/done state. Coordination executes no task commands; resume requires explicit reconciliation, not redispatch. Provider-session resume is unimplemented. |
| Concurrent work | Current installed workflow fixtures reject overlap/forged/stale claims and validate disjoint digest-bound review, quarantine and bounded retries. Locks and caller identities are coordination controls, not OS containment. |
| Stale context | Current unit gates replay packet source/fingerprint/continuation negatives; unchanged implementation binds prior v1.39 installed proofs. Context references remain process-local and restart/changed source requires rereading. |
| Skill injection | Current installed STDIO/HTTP reviewed-skill loads and negative permission/provenance tests replayed; configured connector project remains unchanged. Skills are untrusted guidance and grant no permissions. |
| Partial incident data | Current installed fleet/incident/drift/diagnosis fixtures replay unavailable targets, partial evidence, linked hypotheses, source hashes and owner isolation. Loopback unavailable fixtures do not prove successful fleet SSH capture or a confirmed cause. |
| Incident to patch | Source-bound v1.56 real native worker snapshot, registered baseline match, actual red/green, independent reviewer and workflow done are carried unchanged. Current v2 installed incident/diagnosis/workflow fixtures replayed. No deployment occurred. |
| Safety | Current security regressions, installed permission/owner/scope negatives, eight bounded known-credential canaries and configured diagnostics scans passed. Historical actual CLI/tool cancellation and sandbox canaries carried within their stated bounds; no general containment claim. |
| Packaging | Current Ubuntu source/package gates, six provenance artifacts, upgrade 1.56 to 2.0, rollback/uninstall/reinstall, both installed transports and nine DEB/TAR runtime identities passed. Four stopped-state phases preserve 99 state/four config files; running migrations have a separate boundary. |

## Native provider and measured routing

Current installed STDIO/HTTP native calls authenticated through isolated Linux
Codex subscription login and exact pinned CLI 0.146.0. Selected gpt-5.6-sol
worked; gpt-6.1-sol returned MODEL_UNAVAILABLE without fallback. The approved
exact-binary AppArmor profile was temporary and is unloaded; kernel restriction
remains 1 and no persistent profile exists. Normal lab native execution needs
approved host policy readiness. See [native acceptance](NATIVE_LINUX_ACCEPTANCE.md).

workflow_plan prepares caller-native contracts/prompts and starts no execution.
Coordination cancellation does not terminate a worker; owned codex_stop and
actual tool cancellation have separate retained native evidence.

Historical benchmark r3 accepted 4/6 fixtures in both topologies, with zero
observed tool-policy failures and median total token increase 114.85%.
Conservative incident/resume answer checks stayed failed. All earlier runs
are retained; no token savings or new v2-guidance result is claimed.
Seven-day soak is waived, not passed. Automated fixtures and independent QA
do not supply owner usability acceptance or publication approval.

## Earlier Git-only approval — 2026-10-04

The owner approved milestone delivery and pushing all verified versions to the
existing origin/main. Personal coding/incident trial results remain unreported;
automated fixture evidence is not relabeled as an owner trial. Publication/tagging
remains a separate human gate. See [approval record](evidence/2026-10-04-v2.0.0-owner-acceptance.md).

## Completed release publication — 2026-10-04

The owner's later explicit release request approved the publication gate. All 17 implemented milestones are public, with 102 matching GitHub asset digests and original accepted source tags. The earlier Git-delivery-only entry above is historical. [Publication receipt](evidence/2026-10-04-roadmap-publication.md).

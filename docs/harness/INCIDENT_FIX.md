# Incident to local fix

`incident_fix prepare` links an owned exact-hash diagnosis to a currently
resolved `fleet_catalog` service/workspace mapping and creates one ready durable
workflow task atomically. Supply mapping revision, the normal task contract and
bounded ranges from its allowed files. Explicit acceptance commands and criteria
describe the regression; this tool never runs them or edits code.

The validated incident header must match the mapped workspace, host, unit and
registration fingerprints. Partial observations keep explicit unknowns. Caller
confidence and narrative remain hypotheses. Select only necessary source ranges:
eight maximum, 200 lines each, file reads128 KiB maximum and snippets8 KiB total.
Known secret paths, stale bindings and unrelated file scopes are rejected.

Preparation returns a resolvable `incident_fix:v1:<fixId>:<linkHash>` reference,
workflow/task IDs and retained source hashes. Exact request repeat returns the
same workflow. Changed ID reuse fails. Immutable storage is limited to32 KiB
per document,32 records per owner and256 globally. Hashes attest retained bytes,
not a human identity or the truth of a diagnosis.

Use existing `workflow start` with a distinct worker identity, then perform the
approved local patch and deterministic regression checks. Handoff to verifying,
submit `workflow review` with an independent reviewer and registered artifact
hashes, then complete done. The original task contract JSON, baseline/source/diff
fingerprints, attempt and QA receipt bind the preparation reference. READ/WRITE
checks, fenced leases, retry limits and file ownership still apply.

Latest workflow start/review/verifying/done validate linked incident/mapping
freshness after other awaited checks and before mutation. Initial context must
be current at start. The patch may legitimately change it: subsequent QA verifies
the actual bounded diff rather than requiring the initial source to stay equal.
`incident_fix status` returns historical context, current context/link status,
task states and retained QA information separately. Status needs current READ;
it neither starts nor resumes execution and stale evidence never grants authority.

Migration018 remains readable with older binaries. They omit the incident-link
freshness checks: stop writers and withhold linked workflows from execution
during rollback until upgraded. Metadata coordination provides no OS sandbox.
Deployment, production mutation and publication still require their human gates.

v1.50 implementation and full local/Ubuntu/package/installed acceptance are open.
See the [contract](contracts/v1.50-incident-fix.md). Installed unavailable-host
fixtures and caller-native local patches are distinct from real fleet usability,
native CLI authentication or a proven incident cause.

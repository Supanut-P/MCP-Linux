# Incident workspace

The v1.47 candidate adds `incident` to the fleet and full profiles. Verification
is in progress; implementation alone does not close the milestone.

```json
{"operation":"collect","incidentId":"outage-20261003-01","workspaceId":"registered-workspace","hostIds":["registered-host"],"unit":"app.service"}
```

Use either `hostIds` (at most 20) or an owned `selectionId`. A mapping must still
resolve to the requested workspace; stale mappings are rejected. Groups retain
explicit stale or unavailable host observations. The server validates each
registration before and after its fixed probes. Metadata grants no SSH or file
authority. Unit omission leaves service-status and journal gaps.

Collection requires current READ and WRITE policy, including `userConfirmed`
when WRITE asks. It persists a header before probing and returns a durable ID.
Repeating that ID with identical inputs reads existing state without replaying
probes. Different inputs fail; choose a new incident ID for a new collection.
Caller names do not change the CLI's fixed owner principal. Ownership is metadata
isolation, not tenant authentication.

```json
{"operation":"status","incidentId":"outage-20261003-01"}
```

```json
{"operation":"report","incidentId":"outage-20261003-01","afterSequence":0,"limit":16}
```

Reports include paged evidence references with content hashes, current binding
status and explicit missing observations. `nextAfterSequence` continues the
bounded page; a final full page may be followed by an empty page. Timeline times
are collection observations, not provider event times. Registration checks that
exceed the request deadline are unavailable and flag `registryDeadlineReached`;
they do not change retained historical observations.

There are four remote readers at most and one shared 60-second request deadline.
Expired collecting records project `interrupted`. Terminal/expired records reject
late appends and finalization. Restart never automatically resumes probes. Partial
rows survive, including failed hosts. The database limits each owner to 32
incidents, 256 globally, and each incident to 128 rows/256 KiB. No automatic
deletion is performed.

Raw journal messages, remote errors, credentials, connection details and watcher
paths are omitted. Journal evidence contains counts and a hash with
`messageOmitted:true`; watcher paths are hashed. Numeric runtime metrics describe
the MCP server, not remote hosts. Watcher history is not deployment history. A
hash verifies retained bytes, not the truth of an observation. Missing, omitted,
stale or truncated evidence cannot establish absence.

# Remote rollout tasks

`remote_rollout` remains the same v1 tool and schema. Version 1.11 adds a
standard MCP Tasks path for clients that need to start a long-running rollout,
disconnect, and reconnect later.

## Flow

1. Call `remote_rollout` with `operation: "plan"` and retain the returned
   `rolloutId` and aggregate `previewHash`.
2. Send the existing confirmed execute request inside a task-augmented
   `tools/call` envelope (`task: {}`).
3. Poll `tasks/get` using the rollout ID. `tasks/list` only returns tasks owned
   by the same client/session actor.
4. Use `tasks/result` for the terminal sanitized summary, or `tasks/cancel` to
   stop a working rollout from scheduling more hosts.

The task owner is a hash of the trusted transport actor and session. It is not
stored or returned as a client identifier, and another actor receives the same
not-found behavior as an unknown task. A reconnect must preserve the MCP
protocol session ID so the actor remains the same.

## Progress retention

Each rollout retains at most the newest 200 events. An event contains only:

- registered host alias
- phase (`canary`, `batch`, or `resume`)
- attempt number
- status and sanitized result code
- timestamp

Addresses, usernames, fingerprints, key paths, commands, credentials, and raw
provider messages are never written to the event stream. Event writes are
serialized before SQLite persistence so concurrent host workers cannot overwrite
one another's progress.

## Safety and limits

- The existing preview hash, workspace match, explicit confirmation, host
  registration, and remote capability policy remain mandatory.
- A task cannot claim an already running or terminal rollout, and a rollout can
  have only one owner.
- Unknown remote outcomes remain `unverified`; the task never reports success
  merely because a remote process stopped responding.
- `tasks/result` follows the existing bounded wait window. If the rollout is
  still working, poll `tasks/get` later instead of tight polling in one turn.

This feature does not add arbitrary SSH commands, connection metadata, new
authority profiles, or automatic host registration.

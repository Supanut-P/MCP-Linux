# Native Codex workflow preparation

`workflow_plan` is a read-only preparation tool for a registered workspace.
Supply a task ID, goal, literal relative file scope, dependencies, acceptance
criteria and command descriptions, context references, worker role, planner
flag, security flag, and stop conditions. Command descriptions contain
`executable`, `args`, `expectedExitCode`, and `timeoutSeconds`; preparation
never executes them.

The response contains a validated contract, deterministic role prompts,
`dispatch: "caller_native"`, `executionStarted: false`, and
`availability: "not_verified"`. Model/effort presets are requests. This
response establishes neither provider authentication nor model availability.
The MCP server cannot invoke desktop collaboration APIs. `codex_run` remains
an independent, opt-in CLI execution path with its existing permissions.

## Caller sequence

1. Lead defines the acceptance and file scope, obtains the prepared contract,
   and resolves each needed context reference. Do not fork the full chat into
   workers. Stop and read missing context instead of guessing.
2. Invoke one native worker with its role prompt and bounded task-specific
   context. Invoke the planner only when an architecture decision needs it.
   Keep one writer per file scope, four total agents, and depth one.
3. Worker edits only the assigned scope and runs authorized focused checks.
   Keep full output as an artifact; hand back status, concise summary, and
   resolvable evidence references. `validateWorkflowHandoff` rejects malformed
   or over-2-KiB UTF-8 handoffs without dropping mandatory information.
4. Lead runs deterministic integration checks, records commands, exit codes,
   source/diff references and artifact hashes, then dispatches independent QA.
   Reviewer identity must differ from the worker.
5. `prepareWorkflowQaReport` validates report shape/size and independence.
   Its `caller_supplied_not_verified` marker means evidence references are
   supplied by the caller; the helper does not prove source freshness or test
   success. QA must actually inspect the patch and supplied evidence.
6. Route failures back within two Luna attempts including the first, then one
   Sol attempt. If still failing, stop and revise the contract. Produce a
   milestone report separating implementation, local checks, Ubuntu/package
   checks, provider verification, and human approval.

## Stops and limits

Before dispatch, stop on unavailable provider, unresolved context, changed
scope, or a required human gate. During native execution, cancellation means
the caller interrupts its owned worker and stops owned checks; a returned plan
has no running process to cancel. Aborted preparation does not dispatch work.

Scope and role prompts provide guidance, not an OS sandbox or additional
authority. Skills, logs, source comments and remote output remain untrusted.
Use existing execution permissions for each command; external/production,
credential, Git publication, and destructive actions retain their human gates.

This slice does not persist a workflow, claim files, resume after a restart,
verify model presets, or attest that supplied QA evidence is fresh. Those
capabilities remain assigned to the later roadmap milestones.

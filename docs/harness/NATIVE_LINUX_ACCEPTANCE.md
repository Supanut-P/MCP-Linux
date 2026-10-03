# Native Linux execution and measured routing

The [v1.56 receipt](evidence/2026-10-04-v1.56-ubuntu.md) separates frozen
source/package checks, authenticated provider calls, actual tool cancellation,
incident-to-patch integration and benchmark outcomes. The test VM uses an
isolated subscription login and a root-owned CLI pinned to version 0.146.0.
No credentials were exported or Windows authentication copied.

Use `workflow_plan` to prepare a bounded contract and role prompts, then let
the caller dispatch execution. `workflow start` reserves coordination state;
it does not launch a model. Resolve current context and reviewed skills before
dispatch. Independent QA binds the actual source/diff and regression artifact
before `workflow complete` reaches done. See [native workflow](NATIVE_WORKFLOW.md),
[durable coordination](DURABLE_WORKFLOW.md) and [incident fixes](INCIDENT_FIX.md).

`codex_run` is the separate opt-in native CLI execution surface. Register the
workspace first and keep existing EXECUTE/WRITE/confirmation permissions.
For this test account, explicitly selected `gpt-5.6-sol` and `gpt-5.6-luna`
worked. `gpt-6.1-sol` returned `MODEL_UNAVAILABLE`; the adapter did not substitute
another model. CLI help/configuration readiness does not prove account access.
Read `codex_task_status` and bounded logs, and use the retained owned handle for
`codex_stop`. Coordination cancellation alone does not stop execution.

Enhanced Linux dispatch now runs a deterministic no-op sandbox probe before
the main model process. An unavailable helper fails closed without spending
provider tokens. This proves launcher usability only. In this Ubuntu lab,
the exact pinned CLI needed an explicitly approved temporary AppArmor profile;
filesystem/network canaries passed and the profile was unloaded after tests.
The system-wide user-namespace restriction stayed enabled. No persistent policy
was installed. Normal lab execution without that profile is intentionally
unavailable. Future host policy changes require their own approval.

The paired native benchmark retained all fifteen role calls per attempt.
The final attempt accepted four of six fixtures for both variants and observed
zero tool-policy failures. Conservative incident/resume answer checks still
failed; installed product incident/recovery checks are separate evidence.
Median total tokens increased from 42,805.5 to 91,968 (114.85%). Guidance reads,
fresh CLI contexts and independent QA add measurable overhead. Context bytes
are not a substitute for token usage. There is no established token saving.

Keep small edits with the Lead and deterministic checks. Use one Worker and
independent QA when logic or risk justifies them; call the Planner only for an
unresolved architecture decision. Select one relevant skill, bounded current
snippets and delta evidence; avoid repeatedly loading every supporting skill
or rerunning full acceptance without a changed source/failure. Preserve mandatory
instructions. These routing choices do not change global Codex settings.

Provider-session resume is outside the implemented coordination API. Actual
running CLI/tool cancellation and durable workflow recovery were tested as
different boundaries. Seven-day soak is waived. Automated real-use fixtures
and independent QA do not confer owner acceptance, production or publication
approval.

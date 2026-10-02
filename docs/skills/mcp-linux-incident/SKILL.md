---
name: mcp-linux-incident
description: Triage Baitonghub Linux MCP or registered-host incidents using bounded read-only evidence and explicit confidence labels.
---

# MCP Linux incident triage

Start with bounded read probes against explicitly registered host IDs and the named workspace/service. Do not broaden the target or permissions to investigate. Preserve timestamps, source references, result status, and whether output is partial or truncated. Separate observed facts from hypotheses; label unknowns and confidence explicitly. A timeout, partial result, or truncated result is not proof of absence or success.

Keep incident work read-only. Do not apply automatic production fixes, restart services, alter credentials, or expand filesystem/host access. Report the evidence, limits, plausible hypotheses, and the narrowest next probe. Stop for human direction before any production change.

Read [remote fleet bounds](../../linux/REMOTE_FLEET.md) and [architecture](../../linux/ARCHITECTURE.md) when remote scope or provider behavior matters. For release integrity symptoms, consult the [release checklist](../../../.github/RELEASE_CHECKLIST.md).

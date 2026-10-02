# Existing tunnel follow-up — 2026-10-01 (Asia/Bangkok)

The user confirmed the previously configured host/account and authorized
continuing inspection. All remote checks below were read-only. No package,
service, profile, or credential was changed.

- Native connector `health(check_all)` returned Linux backend capabilities.
- `workspace_list` returned the existing registered project workspace.
- `read_file(package.json, lines 1–16)` succeeded. Its source version is
  1.11.0; this is not the installed runtime version.
- Connector shell `id -un` returned `adminops`.
- Both `baitonghub-linux-mcp@adminops.service` and
  `baitonghub-linux-mcp-tunnel@adminops.service` are active/running as adminops.
- `dpkg-query` reports the installed package as **1.36.0**.
- Filename-only inventory found the existing tunnel profile at
  `/home/adminops/.config/tunnel-client/baitonghub-linux-mcp.yaml`, mode 600.
  No profile or credential contents were read.
- Tunnel `/healthz` and `/readyz` on port 18766 both returned HTTP 200.
  `/health` returned 404; initially parsing it as JSON failed. That initial
  attempt is not readiness evidence.
- SSH BatchMode authentication failed (`publickey,password`). Inspection
  continued through the working native connector.
- `sudo -n true` returned 1: passwordless elevation is unavailable.
- `/home` has 807748 KiB available and is 95% used. No cleanup was performed.

These results verify the existing 1.36 connector/service path only. They do
not close candidate 1.37 tunnel, reconnect, secret-canary, or packaged fleet
acceptance gates. Installing the verified artifact and checking reconnect
requires authenticated operator access. The user was asked whether the
previously supplied test-VM password applies to this account. Never put that
password in a connector command or durable task.

## Authorized continuation

The user authorized reusing the supplied test-VM password for adminops and
explicitly requested a persistent goal through the approved roadmap. That
goal is active. A strict-known-host Paramiko SSH attempt received the password
through hidden stdin, kept it in memory only, and failed with
`AuthenticationException`. No remote install/restart was executed. Do not
repeat failed password attempts without corrected authentication information.

The user was asked for a working SSH key/agent or to confirm after resetting
the account password themselves. Candidate and rollback DEB hashes were
rechecked locally and match the previous Ubuntu receipt:

- Candidate 1.37.0:
  `559d64d75ed22d05067084b6ad10227fa0e4e0db57f5005c99c15f3d9713ef74`.
- Rollback 1.36.0:
  `16d73d1811d55d13c7060063369f7d67a5fc5091062923b1ef37b89daf724888`.

Next operator steps, once authentication works: create a separate bounded
test-lab directory; transfer and verify these exact artifacts; preserve
runtime state and verify rollback availability; install candidate; verify
MCP/tunnel restart, readiness and connector calls against candidate runtime;
complete packaged fleet and credential-absence checks; record results bound
to the source/artifacts. No publish, push, tag, or merge is authorized.

Read-only command receipts:

- Service/profile/package inspection: task
  `44712ea6-9a2f-46e6-b4c8-4b82417fcfde`, exit 0.
- Privilege/storage inspection: task
  `a1ac7f0e-c40c-4dfb-a774-5eeab6644198`, overall exit 0, with the individual
  failed JSON parse and sudo probe qualified above.
- Health endpoint status probe: task
  `4b5dd2b5-3816-4680-8214-83fef654dfe3`, exit 0.

## Blocked audit

The operator-authentication blocker persisted across three consecutive goal
turns. The final read-only recheck, connector task
`b17561bb-c7de-420d-a6a0-f55d99709a27`, completed with exit 0: adminops,
installed package 1.36.0, both services active, tunnel `/readyz` HTTP 200,
and `sudo -n true` exit 1. No failed password retry was performed.

The goal is **blocked**, not complete or user-paused. The other approved
disposable VM has separate [candidate package/fleet evidence](2026-10-01-packaged-fleet.md).
Candidate install and tunnel reconnect on this configured host still need
working authentication. Sequential gates forbid starting 1.38 while this
gate is open. Resume the unchanged v2.0 goal when working SSH key/agent access
is supplied or the user confirms corrected account authentication.

# Baitonghub-Linux-mcp v0.3.0

This release adds controlled Linux server administration to the headless MCP
runtime while preserving registered-root, confirmation, ownership, and audit
boundaries.

## Included

- `service`: inspect and manage allowlisted systemd units with fixed `systemctl`
  argv.
- `package`: inspect Debian packages and produce bounded `apt-get --simulate`
  plans before confirmed changes.
- `schedule`: create and manage user-only systemd timers under
  `XDG_CONFIG_HOME/systemd/user`.
- Request-bound plan hashes, explicit confirmation, package limits, and hard
  blocks for shutdown/reboot/rescue operations, repository changes, lock
  bypasses, system cron, and paths outside registered roots.
- Structured dependency health and unavailable/unsupported results for Linux
  providers.

## Safety

State-changing operations require `userConfirmed: true`; package changes also
require a matching simulation `plan_hash`. Commands use argument arrays with
`shell:false`, output is bounded, and credential-shaped values are redacted.

Supported release target: Ubuntu 24.04 x86_64 headless runtime.

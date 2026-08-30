# v1.5.0 clean-VM evidence runbook

Run this only on a disposable Ubuntu 24.04 x86_64 snapshot. It is an operator
runbook, not an automated deployment script. Never paste tunnel IDs, runtime
keys, API keys, or Secret Service values into the transcript.

## 1. Capture the baseline

```sh
set -eu
export EVIDENCE_DIR="$PWD/docs/linux/evidence/v1.5.0/run-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_DIR"
uname -a | tee "$EVIDENCE_DIR/system-before.txt"
dpkg --print-architecture | tee -a "$EVIDENCE_DIR/system-before.txt"
id | tee -a "$EVIDENCE_DIR/system-before.txt"
```

Record the package SHA-256 files and exact source commit. Hash XDG data/config/state
with `sha256sum` without printing file contents.

## 2. Install and exercise the package

```sh
sudo apt install "./Baitonghub-Linux-mcp-${VERSION}-amd64.deb"
sudo systemctl enable --now "baitonghub-linux-mcp@${USER}.service"
systemctl show "baitonghub-linux-mcp@${USER}.service" -p User -p MainPID
```

Run the packaged STDIO/HTTP smoke and the MCP acceptance calls. Keep the service
owner non-root and retain only sanitized output.

## 3. Upgrade, rollback, uninstall, and reinstall

Use two locally verified DEBs from adjacent versions. Capture each command's
exit status and the service owner, but do not use `apt purge` or remove XDG
directories: state preservation is part of this gate.

```sh
sudo apt install "./Baitonghub-Linux-mcp-${NEXT_VERSION}-amd64.deb"
sudo apt install "./Baitonghub-Linux-mcp-${PREVIOUS_VERSION}-amd64.deb"
sudo apt remove baitonghub-linux-mcp
sudo apt install "./Baitonghub-Linux-mcp-${VERSION}-amd64.deb"
```

After reinstall, rerun the smoke client, verify the SQLite/audit state hash is
preserved, and confirm the service starts as the intended non-root user.

## 4. Tunnel and soak evidence

Configure the tunnel client through the approved Secret Service flow. Do not
write credentials to this repository or the transcript. Verify health and one
MCP read call, restart the service, and record reconnect evidence. Then run:

```sh
SOAK_DURATION_SECONDS=604800 SOAK_INTERVAL_SECONDS=300 \
  bash scripts/soak-linux-headless.sh
bash scripts/verify-soak-linux-headless.sh \
  "$XDG_STATE_HOME/baitonghub-linux-mcp/soak-linux-headless.tsv"
```

The verifier's default seven-day minimum is mandatory for a production claim.
A short run with `SOAK_MIN_DURATION_SECONDS` is only a smoke check and must not
be placed in the release evidence directory as production proof.

## 5. Retain and review

Store sanitized transcripts, package/provenance checksums, before/after state
hashes, service owner output, tunnel health/reconnect evidence, and the verified
soak TSV under the evidence directory. Redact keys and tokens before review.

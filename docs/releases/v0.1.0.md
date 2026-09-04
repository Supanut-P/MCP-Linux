# Baitonghub-Linux-mcp v0.1.0

The first public Baitonghub-Linux-mcp release for Ubuntu 24.04 x64.

## Highlights

- Headless MCP runtime with no Electron, GUI session, or system Node.js
  requirement.
- Workspace-scoped file, search, Git, shell, owned background process, audit,
  checkpoint, and backup capabilities.
- STDIO and authenticated Streamable HTTP transports.
- Official outbound-only OpenAI Secure MCP Tunnel integration for ChatGPT.
- Systemd service templates with protected credential loading.
- Strict registered-root policy with symlink-escape protection and hard blocks
  for root escalation and machine-level destructive operations.

## Downloads

- `Baitonghub-Linux-mcp-0.1.0-amd64.deb`
- `Baitonghub-Linux-mcp-0.1.0-linux-x64.tar.gz`
- `Baitonghub-Linux-mcp-0.1.0-SHA256SUMS`

Verify the package before installation:

```sh
sha256sum --check --ignore-missing Baitonghub-Linux-mcp-0.1.0-SHA256SUMS
sudo apt install ./Baitonghub-Linux-mcp-0.1.0-amd64.deb
```

## Supported platform

- Ubuntu 24.04 LTS
- x86_64 / amd64
- Headless STDIO and Streamable HTTP MCP
- OpenAI Secure MCP Tunnel

ARM64, RPM, GUI automation, Windows migration, and unrestricted root access are
not included in v0.1.0.

See `README.md` for installation and quick-start instructions and
`HEADLESS_LINUX.md` for the full server and tunnel operator guide.

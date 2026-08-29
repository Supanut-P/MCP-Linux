import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('Secure MCP Tunnel reconnect contract', () => {
  it('runs health/doctor before the long-lived run and delegates recovery to systemd', async () => {
    const launcher = await readFile(path.join(root, 'scripts', 'start-baitonghub-linux-mcp-tunnel.sh'), 'utf8');
    const unit = await readFile(path.join(root, 'packaging', 'linux-headless', 'baitonghub-linux-mcp-tunnel@.service'), 'utf8');
    expect(launcher.indexOf('doctor')).toBeGreaterThan(-1);
    expect(launcher.indexOf('doctor')).toBeLessThan(launcher.indexOf('exec "$tunnel_client" run'));
    expect(launcher).toContain('--health.listen-addr 127.0.0.1:18766');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5s');
    expect(unit).toContain('KillMode=control-group');
  });
});

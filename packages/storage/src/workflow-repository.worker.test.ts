import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteWorkflowRepository } from './workflow-repository.js';

const enabled = typeof process.env.WORKFLOW_RACE_DB === 'string';

describe('workflow lease process worker', () => {
  it.skipIf(!enabled)('attempts one claim and writes only its boolean result', async () => {
    const filename = process.env.WORKFLOW_RACE_DB!;
    const workflowId = process.env.WORKFLOW_RACE_ID!;
    const ownerKey = process.env.WORKFLOW_RACE_OWNER!;
    const token = process.env.WORKFLOW_RACE_TOKEN!;
    const resultPath = process.env.WORKFLOW_RACE_RESULT!;
    const db = new SqliteDatabase(filename);
    try {
      const now = new Date().toISOString();
      const claimed = new SqliteWorkflowRepository(db).claim(ownerKey, workflowId, 'first', 0, token, now, {
        mode: 'workspace', scopes: [{ path: '/workspace/process-race', inode: null }],
        workspaceFingerprint: 'c'.repeat(64), baselineJson: '{"files":[]}', expiresAt: new Date(Date.parse(now) + 600_000).toISOString(),
      });
      await writeFile(resultPath, JSON.stringify({ claimed }), { flag: 'wx' });
      expect(typeof claimed).toBe('boolean');
    } finally { db.close(); }
  });
});

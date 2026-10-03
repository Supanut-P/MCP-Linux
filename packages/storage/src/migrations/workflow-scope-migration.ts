export const WORKFLOW_SCOPE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS durable_workflow_leases (
  lease_id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES durable_workflows(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','quarantined','released')),
  expires_at TEXT NOT NULL,
  reservation_json TEXT NOT NULL,
  last_source_fingerprint TEXT,
  created_at TEXT NOT NULL,
  released_at TEXT,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
  FOREIGN KEY(workflow_id, task_id) REFERENCES durable_workflow_tasks(workflow_id, task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_leases_state ON durable_workflow_leases(state, expires_at);
CREATE TABLE IF NOT EXISTS durable_workflow_lease_scopes (
  lease_id TEXT NOT NULL REFERENCES durable_workflow_leases(lease_id) ON DELETE CASCADE,
  scope_path TEXT NOT NULL,
  inode TEXT,
  PRIMARY KEY(lease_id, scope_path)
);
CREATE TRIGGER IF NOT EXISTS workflow_lease_global_limit BEFORE INSERT ON durable_workflow_leases WHEN NEW.state!='released' AND (SELECT COUNT(*) FROM durable_workflow_leases WHERE state!='released')>=512 BEGIN SELECT RAISE(ABORT, 'workflow lease limit reached'); END;
CREATE INDEX IF NOT EXISTS idx_workflow_lease_scopes_path ON durable_workflow_lease_scopes(scope_path);
CREATE INDEX IF NOT EXISTS idx_workflow_lease_scopes_inode ON durable_workflow_lease_scopes(inode);
INSERT INTO durable_workflow_leases(lease_id,workflow_id,task_id,state,expires_at,reservation_json,last_source_fingerprint,created_at,legacy)
SELECT 'legacy-' || lower(hex(randomblob(16))), t.workflow_id, t.task_id, 'quarantined', '9999-12-31T23:59:59.999Z',
       '{"mode":"workspace","scopes":[{"path":"/__legacy_unreconciled__","inode":null}],"workspaceFingerprint":"0000000000000000000000000000000000000000000000000000000000000000","baselineJson":"{}","expiresAt":"9999-12-31T23:59:59.999Z"}',
       NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1
FROM durable_workflow_tasks t
WHERE t.state IN ('running','verifying')
  AND NOT EXISTS (SELECT 1 FROM durable_workflow_leases l WHERE l.workflow_id=t.workflow_id AND l.task_id=t.task_id);
INSERT INTO durable_workflow_lease_scopes(lease_id,scope_path,inode)
SELECT lease_id,'/__legacy_unreconciled__',NULL FROM durable_workflow_leases WHERE legacy=1;
CREATE TRIGGER IF NOT EXISTS workflow_v143_workflows_insert BEFORE INSERT ON durable_workflows WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v143_workflows_update BEFORE UPDATE ON durable_workflows WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v143_workflows_delete BEFORE DELETE ON durable_workflows WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v143_tasks_insert BEFORE INSERT ON durable_workflow_tasks WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v143_tasks_update BEFORE UPDATE ON durable_workflow_tasks WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v143_tasks_delete BEFORE DELETE ON durable_workflow_tasks WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v143_events_insert BEFORE INSERT ON durable_workflow_events WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v143_events_update BEFORE UPDATE ON durable_workflow_events WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v143_events_delete BEFORE DELETE ON durable_workflow_events WHEN workflow_v143_guard() != 143 BEGIN SELECT RAISE(ABORT, 'workflow lease guard required'); END;
`;

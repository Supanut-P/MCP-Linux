export const WORKFLOW_QA_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS durable_workflow_attempts (
  workflow_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
  worker_id TEXT NOT NULL,
  requested_preset TEXT NOT NULL CHECK(requested_preset IN ('Luna','Sol')),
  lease_id TEXT NOT NULL,
  claim_revision INTEGER NOT NULL,
  verification_revision INTEGER,
  source_fingerprint TEXT,
  diff_fingerprint TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','accepted','failed','blocked','done','cancelled')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workflow_id,task_id,attempt_no),
  FOREIGN KEY(workflow_id,task_id) REFERENCES durable_workflow_tasks(workflow_id,task_id) ON DELETE CASCADE,
  FOREIGN KEY(lease_id) REFERENCES durable_workflow_leases(lease_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_lease ON durable_workflow_attempts(lease_id);
CREATE TABLE IF NOT EXISTS durable_workflow_qa_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  lease_id TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('passed','failed','blocked')),
  source_fingerprint TEXT NOT NULL,
  diff_fingerprint TEXT NOT NULL,
  verification_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workflow_id,task_id,attempt_no) REFERENCES durable_workflow_attempts(workflow_id,task_id,attempt_no),
  FOREIGN KEY(lease_id) REFERENCES durable_workflow_leases(lease_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_qa_receipts_task ON durable_workflow_qa_receipts(workflow_id,task_id,created_at,receipt_id);
CREATE TRIGGER IF NOT EXISTS workflow_v144_workflows_insert BEFORE INSERT ON durable_workflows WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_workflows_update BEFORE UPDATE ON durable_workflows WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_workflows_delete BEFORE DELETE ON durable_workflows WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_tasks_insert BEFORE INSERT ON durable_workflow_tasks WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_tasks_update BEFORE UPDATE ON durable_workflow_tasks WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_tasks_delete BEFORE DELETE ON durable_workflow_tasks WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_events_insert BEFORE INSERT ON durable_workflow_events WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_events_update BEFORE UPDATE ON durable_workflow_events WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_events_delete BEFORE DELETE ON durable_workflow_events WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_leases_insert BEFORE INSERT ON durable_workflow_leases WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_leases_update BEFORE UPDATE ON durable_workflow_leases WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_leases_delete BEFORE DELETE ON durable_workflow_leases WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_scopes_insert BEFORE INSERT ON durable_workflow_lease_scopes WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_scopes_update BEFORE UPDATE ON durable_workflow_lease_scopes WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_scopes_delete BEFORE DELETE ON durable_workflow_lease_scopes WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_attempts_insert BEFORE INSERT ON durable_workflow_attempts WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_attempts_update BEFORE UPDATE ON durable_workflow_attempts WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_attempts_delete BEFORE DELETE ON durable_workflow_attempts WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_receipts_insert BEFORE INSERT ON durable_workflow_qa_receipts WHEN workflow_v144_guard() != 144 BEGIN SELECT RAISE(ABORT, 'workflow QA guard required'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_receipts_update BEFORE UPDATE ON durable_workflow_qa_receipts BEGIN SELECT RAISE(ABORT, 'workflow QA receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workflow_v144_receipts_delete BEFORE DELETE ON durable_workflow_qa_receipts BEGIN SELECT RAISE(ABORT, 'workflow QA receipts are immutable'); END;
`;

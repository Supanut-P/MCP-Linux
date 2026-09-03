/** v1.11 durable task ownership and bounded rollout progress events. */
export const REMOTE_ROLLOUT_EVENTS_MIGRATION_SQL = `
ALTER TABLE remote_rollouts ADD COLUMN task_owner_id TEXT;
ALTER TABLE remote_rollouts ADD COLUMN task_state TEXT;
ALTER TABLE remote_rollouts ADD COLUMN events_json TEXT;
`;

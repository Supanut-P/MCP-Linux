/** v1.10 durable resume preview storage; no credentials or connection metadata. */
export const REMOTE_ROLLOUT_RESUME_MIGRATION_SQL = `
ALTER TABLE remote_rollouts ADD COLUMN resume_json TEXT;
`;

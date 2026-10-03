import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { DurableWorkflow, DurableWorkflowTask, WorkflowCheckpoint, WorkflowEvent, WorkflowLease, WorkflowRepository, WorkflowReservation, WorkflowScopeKey, WorkflowTaskState, WorkflowVerification } from '@baitonghub-linux-mcp/domain';
import type { SqliteDatabase } from './database.js';

const STATES = new Set<WorkflowTaskState>(['planned', 'ready', 'running', 'verifying', 'done', 'blocked', 'failed', 'cancelled']);
const TERMINAL = new Set<WorkflowTaskState>(['done', 'blocked', 'failed', 'cancelled']);
const EVENT_TYPES = new Set(['created', ...STATES]);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_EVENTS = 1024;
const MAX_LEASES = 512;

interface WorkflowRow { id: string; owner_key: string; workspace_id: string; created_at: string; cancelled: number; }
interface TaskRow { task_id: string; contract_json: string; dependencies_json: string; state: string; revision: number; checkpoint_json: string | null; claim_token: string | null; }
interface LeaseRow { lease_id: string; workflow_id: string; task_id: string; state: string; expires_at: string; reservation_json: string; last_source_fingerprint: string | null; }
class EventLimitError extends Error {}

/** Durable caller workflow metadata. Claim tokens are deliberately omitted from every read. */
export class SqliteWorkflowRepository implements WorkflowRepository {
  public constructor(private readonly database: SqliteDatabase) {
    // SQLite functions are connection-local; old binaries opening this database do not register it.
    this.database.connection.function('workflow_v143_guard', () => 143);
  }

  public create(workflow: DurableWorkflow): void {
    validateWorkflow(workflow);
    this.tx((db) => {
      const count = db.prepare('SELECT COUNT(*) AS count FROM durable_workflows WHERE owner_key = ?').get(workflow.ownerKey) as { count: number | bigint };
      if (Number(count.count) >= 32) throw new Error('Workflow quota exceeded');
      db.prepare('INSERT INTO durable_workflows(id, owner_key, workspace_id, created_at) VALUES (?, ?, ?, ?)')
        .run(workflow.id, workflow.ownerKey, workflow.workspaceId, workflow.createdAt);
      const put = db.prepare('INSERT INTO durable_workflow_tasks(workflow_id, task_id, contract_json, dependencies_json, state, revision) VALUES (?, ?, ?, ?, ?, 0)');
      for (const t of workflow.tasks) put.run(workflow.id, t.taskId, t.contractJson, JSON.stringify(t.dependencies), t.dependencies.length === 0 ? 'ready' : 'planned');
      this.append(db, workflow.id, null, 'created', workflow.createdAt, null);
      for (const t of workflow.tasks) this.append(db, workflow.id, t.taskId, t.dependencies.length === 0 ? 'ready' : 'planned', workflow.createdAt, 0);
    });
  }

  public get(ownerKey: string, id: string): DurableWorkflow | null {
    return this.read(() => this.readWorkflow(ownerKey, id));
  }

  private readWorkflow(ownerKey: string, id: string): DurableWorkflow | null {
    const db = this.database.connection;
    const row = db.prepare("SELECT CASE WHEN length(id)<=128 THEN id ELSE '' END AS id, CASE WHEN length(owner_key)<=128 THEN owner_key ELSE '' END AS owner_key, CASE WHEN length(workspace_id)<=128 THEN workspace_id ELSE '' END AS workspace_id, CASE WHEN length(created_at)<=64 THEN created_at ELSE '' END AS created_at, cancelled FROM durable_workflows WHERE owner_key = ? AND id = ?").get(ownerKey, id) as WorkflowRow | undefined;
    if (!row || !ID.test(row.id) || !ID.test(row.owner_key) || !ID.test(row.workspace_id) || !validDate(row.created_at) || ![0, 1].includes(row.cancelled)) return null;
    const bounds = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(task_id AS BLOB))+length(CAST(contract_json AS BLOB))+length(CAST(dependencies_json AS BLOB))+COALESCE(length(CAST(checkpoint_json AS BLOB)),0)),0) AS bytes, COALESCE(MAX(length(CAST(contract_json AS BLOB))),0) AS max_contract, COALESCE(MAX(length(CAST(task_id AS BLOB))),0) AS max_task, COALESCE(MAX(length(CAST(dependencies_json AS BLOB))),0) AS max_dependencies, COALESCE(MAX(length(CAST(checkpoint_json AS BLOB))),0) AS max_checkpoint FROM durable_workflow_tasks WHERE workflow_id=?').get(id) as {count:number|bigint;bytes:number|bigint;max_contract:number|bigint;max_task:number|bigint;max_dependencies:number|bigint;max_checkpoint:number|bigint};
    if (Number(bounds.count) < 1 || Number(bounds.count) > 16 || Number(bounds.bytes) > 256 * 1024 || Number(bounds.max_contract) > 32 * 1024 || Number(bounds.max_task) > 128 || Number(bounds.max_dependencies) > 4096 || Number(bounds.max_checkpoint) > 12 * 1024) return null;
    const taskRows = db.prepare("SELECT CASE WHEN length(task_id)<=128 THEN task_id ELSE '' END AS task_id, contract_json, dependencies_json, CASE WHEN length(state)<=16 THEN state ELSE '' END AS state, CASE WHEN typeof(revision)='integer' THEN revision ELSE -1 END AS revision, checkpoint_json, CASE WHEN claim_token IS NULL THEN NULL WHEN length(claim_token)<=256 THEN claim_token ELSE '' END AS claim_token FROM durable_workflow_tasks WHERE workflow_id = ? ORDER BY rowid").all(id) as unknown as TaskRow[];
    if (taskRows.length < 1 || taskRows.length > 16) return null;
    const tasks: DurableWorkflowTask[] = [];
    try {
      for (const t of taskRows) {
        const dependencies: unknown = JSON.parse(t.dependencies_json);
        const checkpoint: unknown = t.checkpoint_json === null ? null : JSON.parse(t.checkpoint_json);
        if (!ID.test(t.task_id) || typeof t.contract_json !== 'string' || Buffer.byteLength(t.contract_json, 'utf8') > 32 * 1024 || !Array.isArray(dependencies) || !dependencies.every((x) => typeof x === 'string') || !STATES.has(t.state as WorkflowTaskState) || !Number.isSafeInteger(t.revision) || t.revision < 0 || !validCheckpoint(checkpoint) || (['running', 'verifying'].includes(t.state) ? !validToken(t.claim_token ?? '') : t.claim_token !== null)) return null;
        tasks.push({ taskId: t.task_id, contractJson: t.contract_json, dependencies, state: t.state as WorkflowTaskState, revision: t.revision, checkpoint });
      }
    } catch { return null; }
    const result: DurableWorkflow = { id: row.id, ownerKey: row.owner_key, workspaceId: row.workspace_id, createdAt: row.created_at, tasks };
    if (!validPersistedWorkflow(result) || Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024 || (row.cancelled === 1 && tasks.some((t) => !TERMINAL.has(t.state))) || !this.validEvents(db, id, new Set(tasks.map((t) => t.taskId)))) return null;
    return result;
  }

  public claim(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, now: string, reservation?: WorkflowReservation): boolean {
    if (!validRevision(expectedRevision) || !validToken(claimToken) || !validDate(now) || !validReservation(reservation, now)) return false;
    return this.tx((db) => {
      this.quarantineExpired(db, now);
      if (!this.validStoredState(ownerKey, id)) return false;
      const wf = this.owned(db, ownerKey, id);
      const task = this.task(db, id, taskId);
      if (!wf || wf.cancelled || !task || task.state !== 'ready' || task.revision !== expectedRevision || task.claim_token !== null || !this.dependenciesDone(db, id, task)) return false;
      if (this.hasUnleasedLegacyTask(db)) return false;
      const count = db.prepare("SELECT COUNT(*) AS count FROM durable_workflow_leases WHERE state!='released'").get() as {count:number|bigint};
      if (Number(count.count) >= MAX_LEASES || this.conflicts(db, reservation!)) return false;
      if (!this.hasEventRoom(db, id, 1)) return false;
      const leaseId = randomUUID();
      db.prepare("INSERT INTO durable_workflow_leases(lease_id,workflow_id,task_id,state,expires_at,reservation_json,last_source_fingerprint,created_at) VALUES(?,?,?,'active',?,?,NULL,?)")
        .run(leaseId, id, taskId, reservation!.expiresAt, JSON.stringify(reservation), now);
      const putScope = db.prepare('INSERT INTO durable_workflow_lease_scopes(lease_id,scope_path,inode) VALUES(?,?,?)');
      for (const scope of reservation!.scopes) putScope.run(leaseId, scope.path, scope.inode);
      db.prepare("UPDATE durable_workflow_tasks SET state='running', revision=revision+1, claim_token=? WHERE workflow_id=? AND task_id=? AND state='ready' AND revision=?")
        .run(claimToken, id, taskId, expectedRevision);
      this.append(db, id, taskId, 'running', now, expectedRevision + 1);
      return true;
    });
  }

  public update(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, state: WorkflowTaskState, checkpoint: WorkflowCheckpoint | null, now: string, verification?: WorkflowVerification): boolean {
    if (!validRevision(expectedRevision) || !validToken(claimToken) || !STATES.has(state) || !validCheckpoint(checkpoint) || !validDate(now) || (verification !== undefined && !validVerification(verification, now))) return false;
    try { return this.tx((db) => {
      this.quarantineExpired(db, now);
      if (!this.validStoredState(ownerKey, id)) return false;
      const wf = this.owned(db, ownerKey, id);
      const task = this.task(db, id, taskId);
      const lease = this.lease(db, id, taskId);
      if (lease !== undefined && !this.scopeRowsMatchReservations(db, [lease.id])) return false;
      if (!wf || wf.cancelled || !task || !lease || lease.state !== 'active' || Date.parse(lease.expiresAt) <= Date.parse(now) || task.claim_token !== claimToken || task.revision !== expectedRevision || !allowed(task.state as WorkflowTaskState, state)) return false;
      const fingerprint = verification?.sourceFingerprint;
      if (state === 'verifying' && fingerprint === undefined) return false;
      if (task.state === 'verifying' && state === 'verifying' && fingerprint !== lease.lastSourceFingerprint) return false;
      if (state === 'done' && (fingerprint === undefined || fingerprint !== lease.lastSourceFingerprint)) return false;
      const nextExpiry = verification?.expiresAt ?? new Date(Date.parse(now) + 300_000).toISOString();
      db.prepare('UPDATE durable_workflow_tasks SET state=?, revision=revision+1, checkpoint_json=?, claim_token=? WHERE workflow_id=? AND task_id=? AND revision=? AND claim_token=?')
        .run(state, checkpoint === null ? null : JSON.stringify(checkpoint), TERMINAL.has(state) ? null : claimToken, id, taskId, expectedRevision, claimToken);
      const renewed = JSON.stringify({ ...lease.reservation, expiresAt: nextExpiry });
      const checkedFingerprint = state === 'verifying' && task.state !== 'verifying' ? fingerprint : null;
      db.prepare('UPDATE durable_workflow_leases SET state=?, expires_at=?, reservation_json=?, last_source_fingerprint=COALESCE(?,last_source_fingerprint) WHERE lease_id=?')
        .run(TERMINAL.has(state) ? 'quarantined' : 'active', nextExpiry, renewed, checkedFingerprint ?? null, lease.id);
      const promote = state === 'done' ? this.promotable(db, id, taskId) : [];
      if (!this.hasEventRoom(db, id, 1 + promote.length)) throw new EventLimitError('Workflow event limit reached');
      this.append(db, id, taskId, state, now, expectedRevision + 1);
      for (const dependent of promote) {
        db.prepare("UPDATE durable_workflow_tasks SET state='ready', revision=revision+1 WHERE workflow_id=? AND task_id=? AND state='planned'").run(id, dependent.task_id);
        this.append(db, id, dependent.task_id, 'ready', now, dependent.revision + 1);
      }
      return true;
    }); } catch (error) { if (error instanceof EventLimitError) return false; throw error; }
  }

  public cancel(ownerKey: string, id: string, now: string): boolean {
    if (!validDate(now)) return false;
    return this.tx((db) => {
      if (!this.validStoredState(ownerKey, id)) return false;
      const wf = this.owned(db, ownerKey, id);
      if (!wf || wf.cancelled) return false;
      const tasks = db.prepare('SELECT task_id, state, revision FROM durable_workflow_tasks WHERE workflow_id=?').all(id) as unknown as Array<{task_id:string;state:string;revision:number}>;
      const active = tasks.filter((t) => !TERMINAL.has(t.state as WorkflowTaskState));
      if (!this.hasEventRoom(db, id, active.length + 1)) return false;
      db.prepare('UPDATE durable_workflows SET cancelled=1 WHERE id=?').run(id);
      db.prepare("UPDATE durable_workflow_leases SET state='quarantined' WHERE workflow_id=? AND state='active'").run(id);
      for (const t of active) {
        db.prepare("UPDATE durable_workflow_tasks SET state='cancelled', revision=revision+1, claim_token=NULL WHERE workflow_id=? AND task_id=?").run(id, t.task_id);
        this.append(db, id, t.task_id, 'cancelled', now, t.revision + 1);
      }
      this.append(db, id, null, 'cancelled', now, null);
      return true;
    });
  }

  public getLease(ownerKey: string, id: string, taskId: string): WorkflowLease | null {
    return this.read(() => this.readLease(ownerKey, id, taskId));
  }

  private readLease(ownerKey: string, id: string, taskId: string): WorkflowLease | null {
    const row = this.database.connection.prepare("SELECT CASE WHEN length(lease_id)<=128 THEN lease_id ELSE '' END AS lease_id, CASE WHEN length(workflow_id)<=128 THEN workflow_id ELSE '' END AS workflow_id, CASE WHEN length(task_id)<=128 THEN task_id ELSE '' END AS task_id, CASE WHEN length(state)<=16 THEN state ELSE '' END AS state, CASE WHEN length(expires_at)<=64 THEN expires_at ELSE '' END AS expires_at, CASE WHEN length(CAST(reservation_json AS BLOB))<=1048576 THEN reservation_json ELSE '' END AS reservation_json, CASE WHEN last_source_fingerprint IS NULL THEN NULL WHEN length(last_source_fingerprint)<=64 THEN last_source_fingerprint ELSE '' END AS last_source_fingerprint FROM durable_workflow_leases l JOIN durable_workflows w ON w.id=l.workflow_id WHERE w.owner_key=? AND l.workflow_id=? AND l.task_id=?").get(ownerKey, id, taskId) as LeaseRow | undefined;
    return row && this.scopeRowsMatchReservations(this.database.connection, [row.lease_id]) ? parseLease(row) : null;
  }

  public concurrentScopes(ownerKey: string, id: string, taskId: string): readonly WorkflowScopeKey[] | null {
    return this.read(() => this.readConcurrentScopes(ownerKey, id, taskId));
  }

  private readConcurrentScopes(ownerKey: string, id: string, taskId: string): readonly WorkflowScopeKey[] | null {
    if (this.get(ownerKey, id) === null || this.lease(this.database.connection, id, taskId) === undefined) return null;
    const db = this.database.connection;
    const own = db.prepare("SELECT CASE WHEN length(lease_id)<=128 THEN lease_id ELSE '' END AS lease_id, CASE WHEN length(created_at)<=64 THEN created_at ELSE '' END AS created_at, CASE WHEN released_at IS NULL THEN NULL WHEN length(released_at)<=64 THEN released_at ELSE '' END AS released_at, CASE WHEN length(state)<=16 THEN state ELSE '' END AS state FROM durable_workflow_leases WHERE workflow_id=? AND task_id=?").get(id, taskId) as {lease_id:string;created_at:string;released_at:string|null;state:string} | undefined;
    if (!own || !ID.test(own.lease_id) || !validDate(own.created_at) || !['active','quarantined','released'].includes(own.state) || (own.released_at !== null && !validDate(own.released_at)) || (own.state === 'released') !== (own.released_at !== null)) return null;
    const ownEnd = own.released_at ?? new Date().toISOString();
    const peers = db.prepare("SELECT CASE WHEN length(lease_id)<=128 THEN lease_id ELSE '' END AS lease_id, CASE WHEN length(created_at)<=64 THEN created_at ELSE '' END AS created_at, CASE WHEN released_at IS NULL THEN NULL WHEN length(released_at)<=64 THEN released_at ELSE '' END AS released_at, CASE WHEN length(state)<=16 THEN state ELSE '' END AS state FROM durable_workflow_leases WHERE NOT (workflow_id=? AND task_id=?) AND created_at<=? AND (released_at IS NULL OR released_at>=?) ORDER BY created_at,lease_id LIMIT 513")
      .all(id, taskId, ownEnd, own.created_at) as unknown as Array<{lease_id:string;created_at:string;released_at:string|null;state:string}>;
    if (peers.length > 512 || peers.some((p) => !ID.test(p.lease_id) || !validDate(p.created_at) || !['active','quarantined','released'].includes(p.state) || (p.released_at !== null && !validDate(p.released_at)) || (p.state === 'released') !== (p.released_at !== null))) return null;
    if (peers.length === 0) return [];
    const ids = peers.map((p) => p.lease_id);
    if (!this.scopeRowsMatchReservations(db, ids)) return null;
    const marks = ids.map(() => '?').join(',');
    const scopes = db.prepare(`SELECT CASE WHEN length(CAST(scope_path AS BLOB))<=4096 THEN scope_path ELSE '' END AS path,CASE WHEN inode IS NULL THEN NULL WHEN length(CAST(inode AS BLOB))<=128 THEN inode ELSE '' END AS inode,lease_id FROM durable_workflow_lease_scopes WHERE lease_id IN (${marks}) ORDER BY scope_path LIMIT 32769`).all(...ids) as unknown as Array<{path:string;inode:string|null;lease_id:string}>;
    if (scopes.length > 32768 || scopes.some((s) => !validScope({ path: s.path, inode: s.inode }))) return null;
    const scopeCounts = new Map<string, number>();
    for (const scope of scopes) scopeCounts.set(scope.lease_id, (scopeCounts.get(scope.lease_id) ?? 0) + 1);
    if (peers.some((peer) => (scopeCounts.get(peer.lease_id) ?? 0) < 1 || (scopeCounts.get(peer.lease_id) ?? 0) > 64)) return null;
    return scopes.map(({ path: scopePath, inode }) => ({ path: scopePath, inode }));
  }

  public reconcile(ownerKey: string, id: string, taskId: string, leaseId: string, expectedRevision: number, now: string): boolean {
    if (!validRevision(expectedRevision) || !ID.test(leaseId) || !validDate(now)) return false;
    return this.tx((db) => {
      const wf = this.owned(db, ownerKey, id); const task = this.task(db, id, taskId); const lease = this.lease(db, id, taskId);
      if (!this.validStoredState(ownerKey, id) || (lease !== undefined && !this.scopeRowsMatchReservations(db, [lease.id]))) return false;
      if (!wf || !task || !TERMINAL.has(task.state as WorkflowTaskState) || task.revision !== expectedRevision || !lease || lease.id !== leaseId || lease.state === 'released' || !this.hasEventRoom(db, id, 1)) return false;
      if (lease.state === 'active' && Date.parse(lease.expiresAt) > Date.parse(now)) return false;
      db.prepare("UPDATE durable_workflow_leases SET state='released',released_at=? WHERE lease_id=? AND state IN ('active','quarantined')").run(now, leaseId);
      db.prepare('UPDATE durable_workflow_tasks SET revision=revision+1 WHERE workflow_id=? AND task_id=? AND revision=?').run(id, taskId, expectedRevision);
      this.append(db, id, taskId, task.state, now, expectedRevision + 1);
      return true;
    });
  }

  public events(ownerKey: string, id: string, after: number, limit: number): readonly WorkflowEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return [];
    return this.read(() => this.readEvents(ownerKey, id, after, limit));
  }

  private readEvents(ownerKey: string, id: string, after: number, limit: number): readonly WorkflowEvent[] {
    if (this.get(ownerKey, id) === null) return [];
    const rows = this.database.connection.prepare('SELECT sequence, task_id AS taskId, type, timestamp, revision FROM durable_workflow_events WHERE workflow_id IN (SELECT id FROM durable_workflows WHERE owner_key=? AND id=?) AND sequence>? ORDER BY sequence LIMIT ?').all(ownerKey, id, after, limit) as unknown as WorkflowEvent[];
    return rows;
  }

  private validStoredState(ownerKey: string, id: string): boolean {
    return this.get(ownerKey, id) !== null;
  }

  private validEvents(db: DatabaseSync, id: string, taskIds: ReadonlySet<string>): boolean {
    const rows = db.prepare("SELECT CASE WHEN typeof(sequence)='integer' THEN sequence ELSE -1 END AS sequence, CASE WHEN task_id IS NULL THEN NULL WHEN length(task_id)<=128 THEN task_id ELSE '' END AS task_id, length(task_id) AS task_id_len, CASE WHEN length(type)<=32 THEN type ELSE '' END AS type, length(type) AS type_len, CASE WHEN length(timestamp)<=64 THEN timestamp ELSE '' END AS timestamp, length(timestamp) AS timestamp_len, CASE WHEN revision IS NULL THEN NULL WHEN typeof(revision)='integer' THEN revision ELSE -1 END AS revision FROM durable_workflow_events WHERE workflow_id=? ORDER BY sequence LIMIT ?").all(id, MAX_EVENTS + 1) as unknown as Array<{sequence:number;task_id:string|null;task_id_len:number|null;type:string;type_len:number;timestamp:string;timestamp_len:number;revision:number|null}>;
    return rows.length <= MAX_EVENTS && rows.every((event, index) => Number.isSafeInteger(event.sequence) && event.sequence === index + 1
      && (event.task_id_len === null || event.task_id_len <= 128) && event.type_len <= 32 && Buffer.byteLength(event.type, 'utf8') <= 128
      && event.timestamp_len <= 64 && Buffer.byteLength(event.timestamp, 'utf8') <= 256
      && (event.task_id === null || taskIds.has(event.task_id)) && EVENT_TYPES.has(event.type) && validDate(event.timestamp)
      && (event.revision === null || (Number.isSafeInteger(event.revision) && event.revision >= 0 && event.revision <= 1_000_000))
      && (event.task_id !== null || event.type === 'created' || event.type === 'cancelled'));
  }

  private owned(db: DatabaseSync, owner: string, id: string): WorkflowRow | undefined {
    return db.prepare('SELECT id, owner_key, workspace_id, created_at, cancelled FROM durable_workflows WHERE owner_key=? AND id=?').get(owner, id) as WorkflowRow | undefined;
  }
  private task(db: DatabaseSync, id: string, taskId: string): TaskRow | undefined {
    return db.prepare('SELECT task_id, contract_json, dependencies_json, state, revision, checkpoint_json, claim_token FROM durable_workflow_tasks WHERE workflow_id=? AND task_id=?').get(id, taskId) as TaskRow | undefined;
  }
  private lease(db: DatabaseSync, id: string, taskId: string): WorkflowLease | undefined {
    const row = db.prepare("SELECT CASE WHEN length(lease_id)<=128 THEN lease_id ELSE '' END AS lease_id, CASE WHEN length(workflow_id)<=128 THEN workflow_id ELSE '' END AS workflow_id, CASE WHEN length(task_id)<=128 THEN task_id ELSE '' END AS task_id, CASE WHEN length(state)<=16 THEN state ELSE '' END AS state, CASE WHEN length(expires_at)<=64 THEN expires_at ELSE '' END AS expires_at, CASE WHEN length(CAST(reservation_json AS BLOB))<=1048576 THEN reservation_json ELSE '' END AS reservation_json, CASE WHEN last_source_fingerprint IS NULL THEN NULL WHEN length(last_source_fingerprint)<=64 THEN last_source_fingerprint ELSE '' END AS last_source_fingerprint FROM durable_workflow_leases WHERE workflow_id=? AND task_id=?").get(id, taskId) as LeaseRow | undefined;
    return row ? parseLease(row) ?? undefined : undefined;
  }
  private conflicts(db: DatabaseSync, reservation: WorkflowReservation): boolean {
    if (db.prepare("SELECT 1 AS found FROM durable_workflow_leases WHERE legacy=1 AND state!='released' LIMIT 1").get() !== undefined) return true;
    const leases = db.prepare("SELECT lease_id FROM durable_workflow_leases WHERE state!='released' LIMIT 513").all() as unknown as Array<{lease_id:string}>;
    if (leases.length > MAX_LEASES || !this.scopeRowsMatchReservations(db, leases.map((lease) => lease.lease_id))) return true;
    const bad = db.prepare("SELECT 1 AS found FROM durable_workflow_leases l LEFT JOIN durable_workflow_lease_scopes s ON s.lease_id=l.lease_id WHERE l.state!='released' GROUP BY l.lease_id HAVING COUNT(s.scope_path)<1 OR COUNT(s.scope_path)>64 LIMIT 1").get();
    if (bad !== undefined) return true;
    const rows = db.prepare("SELECT CASE WHEN length(CAST(s.scope_path AS BLOB))<=4096 THEN s.scope_path ELSE '' END AS scope_path,CASE WHEN s.inode IS NULL THEN NULL WHEN length(CAST(s.inode AS BLOB))<=128 THEN s.inode ELSE '' END AS inode FROM durable_workflow_lease_scopes s JOIN durable_workflow_leases l ON l.lease_id=s.lease_id WHERE l.state!='released' LIMIT 32769").all() as unknown as Array<{scope_path:string;inode:string|null}>;
    if (rows.length > 32768 || rows.some((held) => !validScope({ path: held.scope_path, inode: held.inode }))) return true;
    return reservation.scopes.some((wanted) => rows.some((held) => (wanted.inode !== null && wanted.inode === held.inode) || overlaps(wanted.path, held.scope_path)));
  }

  private scopeRowsMatchReservations(db: DatabaseSync, ids: readonly string[]): boolean {
    if (ids.length === 0) return true;
    if (ids.length > MAX_LEASES || ids.some((id) => !ID.test(id))) return false;
    const marks = ids.map(() => '?').join(',');
    const bounds = db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(scope_path AS BLOB))+COALESCE(length(CAST(inode AS BLOB)),0)),0) AS bytes FROM durable_workflow_lease_scopes WHERE lease_id IN (${marks})`).get(...ids) as {count:number|bigint;bytes:number|bigint};
    if (Number(bounds.count) > 32768 || Number(bounds.bytes) > 16 * 1024 * 1024) return false;
    const select = db.prepare("SELECT CASE WHEN length(CAST(reservation_json AS BLOB))<=1048576 AND json_valid(reservation_json) THEN CASE WHEN length(CAST(json_extract(reservation_json,'$.scopes') AS BLOB))<=300000 THEN json_extract(reservation_json,'$.scopes') ELSE '' END ELSE '' END AS scopes FROM durable_workflow_leases WHERE lease_id=?");
    const rows = db.prepare('SELECT scope_path AS path,inode FROM durable_workflow_lease_scopes WHERE lease_id=? ORDER BY scope_path');
    try {
      for (const id of ids) {
        const row = select.get(id) as {scopes:string}|undefined;
        const expected: unknown = JSON.parse(row?.scopes ?? '');
        const actual = rows.all(id) as unknown as WorkflowScopeKey[];
        if (!Array.isArray(expected) || expected.length < 1 || expected.length > 64 || actual.length !== expected.length || expected.some((scope: unknown) => !validScope(scope)) || actual.some((scope) => !validScope(scope))) return false;
        const canonical = (scopes: readonly WorkflowScopeKey[]): string => JSON.stringify([...scopes].sort((a, b) => a.path.localeCompare(b.path)).map((scope) => ({path: scope.path, inode: scope.inode})));
        if (canonical(expected as WorkflowScopeKey[]) !== canonical(actual)) return false;
      }
      return true;
    } catch { return false; }
  }
  private quarantineExpired(db: DatabaseSync, now: string): void {
    const rows = db.prepare("SELECT lease_id,expires_at FROM durable_workflow_leases WHERE state='active'").all() as unknown as Array<{lease_id:string;expires_at:string}>;
    const quarantine = db.prepare("UPDATE durable_workflow_leases SET state='quarantined' WHERE lease_id=? AND state='active'");
    for (const row of rows) if (Date.parse(row.expires_at) <= Date.parse(now)) quarantine.run(row.lease_id);
  }
  private hasUnleasedLegacyTask(db: DatabaseSync): boolean {
    const row = db.prepare("SELECT 1 AS found FROM durable_workflow_tasks t LEFT JOIN durable_workflow_leases l ON l.workflow_id=t.workflow_id AND l.task_id=t.task_id WHERE t.state IN ('running','verifying') AND l.lease_id IS NULL LIMIT 1").get();
    return row !== undefined;
  }
  private dependenciesDone(db: DatabaseSync, id: string, task: TaskRow): boolean {
    let deps: unknown;
    try { deps = JSON.parse(task.dependencies_json); } catch { return false; }
    return Array.isArray(deps) && deps.every((dep) => (db.prepare("SELECT state FROM durable_workflow_tasks WHERE workflow_id=? AND task_id=?").get(id, dep) as {state?:string}|undefined)?.state === 'done');
  }
  private promotable(db: DatabaseSync, id: string, completed: string): TaskRow[] {
    const rows = db.prepare("SELECT task_id, contract_json, dependencies_json, state, revision, checkpoint_json, claim_token FROM durable_workflow_tasks WHERE workflow_id=? AND state='planned'").all(id) as unknown as TaskRow[];
    return rows.filter((t) => { try { const d = JSON.parse(t.dependencies_json) as unknown; return Array.isArray(d) && d.includes(completed) && this.dependenciesDone(db, id, t); } catch { return false; } });
  }
  private hasEventRoom(db: DatabaseSync, id: string, add: number): boolean {
    const x = db.prepare('SELECT COUNT(*) AS count FROM durable_workflow_events WHERE workflow_id=?').get(id) as {count:number|bigint}; return Number(x.count) + add <= MAX_EVENTS;
  }
  private append(db: DatabaseSync, id: string, taskId: string | null, type: string, timestamp: string, revision: number | null): void {
    const x = db.prepare('SELECT COALESCE(MAX(sequence), 0)+1 AS next FROM durable_workflow_events WHERE workflow_id=?').get(id) as {next:number};
    db.prepare('INSERT INTO durable_workflow_events(workflow_id,sequence,task_id,type,timestamp,revision) VALUES(?,?,?,?,?,?)').run(id, x.next, taskId, type, timestamp, revision);
  }
  private tx<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.database.connection;
    db.exec('BEGIN IMMEDIATE;');
    try { const out = fn(db); db.exec('COMMIT;'); return out; } catch (error) { db.exec('ROLLBACK;'); throw error; }
  }

  private read<T>(fn: () => T): T {
    const db = this.database.connection;
    if (db.isTransaction) return fn();
    db.exec('BEGIN;');
    try { const out = fn(); db.exec('COMMIT;'); return out; }
    catch (error) { db.exec('ROLLBACK;'); throw error; }
  }
}

function validateWorkflow(w: DurableWorkflow): void {
  if (!ID.test(w.id) || !ID.test(w.ownerKey) || !ID.test(w.workspaceId) || !validDate(w.createdAt) || !Array.isArray(w.tasks) || w.tasks.length < 1 || w.tasks.length > 16) throw new Error('Invalid workflow');
  if (Buffer.byteLength(JSON.stringify(w), 'utf8') > 256 * 1024) throw new Error('Workflow size exceeded');
  const ids = new Set<string>();
  for (const t of w.tasks) {
    if (!ID.test(t.taskId) || ids.has(t.taskId) || typeof t.contractJson !== 'string' || Buffer.byteLength(t.contractJson, 'utf8') > 32 * 1024 || !contractMatches(t.contractJson, t.taskId, w.workspaceId, t.dependencies) || !Array.isArray(t.dependencies) || t.dependencies.length > 16 || !t.dependencies.every((d: string) => typeof d === 'string') || !STATES.has(t.state) || t.checkpoint !== null || !Number.isSafeInteger(t.revision) || t.revision !== 0) throw new Error('Invalid workflow task');
    ids.add(t.taskId);
  }
  const map = new Map(w.tasks.map((t) => [t.taskId, t]));
  for (const t of w.tasks) if (new Set(t.dependencies).size !== t.dependencies.length || t.dependencies.some((d: string) => d === t.taskId || !map.has(d)) || t.state !== (t.dependencies.length === 0 ? 'ready' : 'planned')) throw new Error('Invalid workflow dependency or initial state');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) throw new Error('Workflow dependency cycle'); if (visited.has(id)) return; visiting.add(id); for (const d of map.get(id)!.dependencies) visit(d); visiting.delete(id); visited.add(id); };
  for (const id of ids) visit(id);
}
function validCheckpoint(c: unknown): c is WorkflowCheckpoint | null {
  if (c === null) return true;
  if (typeof c !== 'object' || c === null) return false;
  const x = c as Record<string, unknown>;
  return Object.keys(x).sort().join(',') === 'executionUncertain,references,summary'
    && typeof x.summary === 'string' && Buffer.byteLength(x.summary, 'utf8') <= 2048
    && Array.isArray(x.references) && x.references.length <= 16 && x.references.every((r) => typeof r === 'string' && Buffer.byteLength(r, 'utf8') <= 512)
    && typeof x.executionUncertain === 'boolean' && Buffer.byteLength(JSON.stringify(c), 'utf8') <= 12 * 1024;
}
function contractMatches(json: string, taskId: string, workspaceId: string, dependencies: readonly string[]): boolean {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const contract = value as Record<string, unknown>;
    return contract.taskId === taskId && contract.workspaceId === workspaceId && Array.isArray(contract.dependencies)
      && contract.dependencies.length === dependencies.length && contract.dependencies.every((d, i) => d === dependencies[i]);
  } catch { return false; }
}
function validPersistedWorkflow(w: DurableWorkflow): boolean {
  const ids = new Set(w.tasks.map((t) => t.taskId));
  if (ids.size !== w.tasks.length || w.tasks.some((t) => !ID.test(t.taskId) || !contractMatches(t.contractJson, t.taskId, w.workspaceId, t.dependencies) || new Set(t.dependencies).size !== t.dependencies.length || t.dependencies.length > 16 || t.dependencies.some((d) => !ids.has(d) || d === t.taskId))) return false;
  const map = new Map(w.tasks.map((t) => [t.taskId, t]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => { if (visiting.has(id)) return false; if (visited.has(id)) return true; visiting.add(id); for (const dep of map.get(id)!.dependencies) if (!visit(dep)) return false; visiting.delete(id); visited.add(id); return true; };
  return [...ids].every(visit);
}
function validRevision(n: number): boolean { return Number.isSafeInteger(n) && n >= 0; }
function validToken(t: string): boolean { return typeof t === 'string' && Buffer.byteLength(t, 'utf8') >= 32 && Buffer.byteLength(t, 'utf8') <= 256; }
function validDate(d: string): boolean { return typeof d === 'string' && d.length <= 64 && !Number.isNaN(Date.parse(d)); }
function validVerification(v: WorkflowVerification, now: string): boolean { return typeof v === 'object' && v !== null && Object.keys(v).sort().join(',') === 'expiresAt,sourceFingerprint' && /^[a-f0-9]{64}$/i.test(v.sourceFingerprint) && validDate(v.expiresAt) && validTtl(now, v.expiresAt); }
function validReservation(v: WorkflowReservation | undefined, now: string): v is WorkflowReservation {
  if (v === undefined || typeof v !== 'object' || v === null || Object.keys(v).sort().join(',') !== 'baselineJson,expiresAt,mode,scopes,workspaceFingerprint' || !['workspace','disjoint'].includes(v.mode) || !Array.isArray(v.scopes) || v.scopes.length < 1 || v.scopes.length > 64 || !/^[a-f0-9]{64}$/i.test(v.workspaceFingerprint) || typeof v.baselineJson !== 'string' || Buffer.byteLength(v.baselineJson, 'utf8') > 512 * 1024 || Buffer.byteLength(JSON.stringify(v), 'utf8') > 1024 * 1024 || !validDate(v.expiresAt) || !validTtl(now, v.expiresAt)) return false;
  try { const baseline: unknown = JSON.parse(v.baselineJson); if (typeof baseline !== 'object' || baseline === null || Array.isArray(baseline)) return false; } catch { return false; }
  const seen = new Set<string>();
  for (const s of v.scopes) {
    if (!validScope(s)) return false;
    if (seen.has(s.path)) return false; seen.add(s.path);
  }
  return true;
}
function validScope(s: unknown): s is {path:string;inode:string|null} {
  if (typeof s !== 'object' || s === null) return false;
  const scope = s as {path?:unknown;inode?:unknown};
  const absolute = typeof scope.path === 'string' && (scope.path.startsWith('/') || /^[a-z]:\//.test(scope.path));
  return Object.keys(scope).sort().join(',') === 'inode,path' && typeof scope.path === 'string' && Buffer.byteLength(scope.path, 'utf8') <= 4096 && scope.path === scope.path.toLowerCase() && !scope.path.includes('\\') && !scope.path.includes('\0') && ![...scope.path].some((character) => character.charCodeAt(0) < 32) && absolute && !scope.path.includes('//') && !scope.path.split('/').some((part: string) => part === '..' || part === '.')
    && (scope.inode === null || (typeof scope.inode === 'string' && Buffer.byteLength(scope.inode, 'utf8') <= 128 && /^[0-9]+:[0-9]+$/.test(scope.inode)));
}
function validTtl(now: string, expiry: string): boolean { const ttl = Date.parse(expiry) - Date.parse(now); return ttl >= 60_000 && ttl <= 3_600_000; }
function overlaps(a: string, b: string): boolean { const x = a.replace(/\/$/, ''); const y = b.replace(/\/$/, ''); return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); }
function parseLease(row: LeaseRow): WorkflowLease | null {
  if (!ID.test(row.lease_id) || !ID.test(row.workflow_id) || !ID.test(row.task_id) || !['active','quarantined','released'].includes(row.state) || !validDate(row.expires_at)) return null;
  try { const reservation: unknown = JSON.parse(row.reservation_json); if (!validReservationWithoutNow(reservation)) return null;
    if (row.last_source_fingerprint !== null && !/^[a-f0-9]{64}$/i.test(row.last_source_fingerprint)) return null;
    if (reservation.expiresAt !== row.expires_at) return null;
    return { id: row.lease_id, workflowId: row.workflow_id, taskId: row.task_id, state: row.state as WorkflowLease['state'], expiresAt: row.expires_at, reservation, lastSourceFingerprint: row.last_source_fingerprint };
  } catch { return null; }
}
function validReservationWithoutNow(value: unknown): value is WorkflowReservation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as WorkflowReservation;
  const now = new Date(Date.parse(v.expiresAt) - 300_000).toISOString();
  return validReservation(v, now);
}
function allowed(from: WorkflowTaskState, to: WorkflowTaskState): boolean {
  if (from === 'running') return ['running', 'verifying', 'blocked', 'failed', 'cancelled'].includes(to);
  if (from === 'verifying') return ['verifying', 'done', 'failed', 'blocked', 'cancelled'].includes(to);
  return false;
}

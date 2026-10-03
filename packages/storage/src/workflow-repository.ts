import type { DatabaseSync } from 'node:sqlite';
import type { DurableWorkflow, DurableWorkflowTask, WorkflowCheckpoint, WorkflowEvent, WorkflowRepository, WorkflowTaskState } from '@baitonghub-linux-mcp/domain';
import type { SqliteDatabase } from './database.js';

const STATES = new Set<WorkflowTaskState>(['planned', 'ready', 'running', 'verifying', 'done', 'blocked', 'failed', 'cancelled']);
const TERMINAL = new Set<WorkflowTaskState>(['done', 'blocked', 'failed', 'cancelled']);
const EVENT_TYPES = new Set(['created', ...STATES]);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_EVENTS = 1024;

interface WorkflowRow { id: string; owner_key: string; workspace_id: string; created_at: string; cancelled: number; }
interface TaskRow { task_id: string; contract_json: string; dependencies_json: string; state: string; revision: number; checkpoint_json: string | null; claim_token: string | null; }
class EventLimitError extends Error {}

/** Durable caller workflow metadata. Claim tokens are deliberately omitted from every read. */
export class SqliteWorkflowRepository implements WorkflowRepository {
  public constructor(private readonly database: SqliteDatabase) {}

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

  public claim(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, now: string): boolean {
    if (!validRevision(expectedRevision) || !validToken(claimToken) || !validDate(now)) return false;
    return this.tx((db) => {
      if (!this.validStoredState(ownerKey, id)) return false;
      const wf = this.owned(db, ownerKey, id);
      const task = this.task(db, id, taskId);
      if (!wf || wf.cancelled || !task || task.state !== 'ready' || task.revision !== expectedRevision || task.claim_token !== null || !this.dependenciesDone(db, id, task)) return false;
      if (!this.hasEventRoom(db, id, 1)) return false;
      db.prepare("UPDATE durable_workflow_tasks SET state='running', revision=revision+1, claim_token=? WHERE workflow_id=? AND task_id=? AND state='ready' AND revision=?")
        .run(claimToken, id, taskId, expectedRevision);
      this.append(db, id, taskId, 'running', now, expectedRevision + 1);
      return true;
    });
  }

  public update(ownerKey: string, id: string, taskId: string, expectedRevision: number, claimToken: string, state: WorkflowTaskState, checkpoint: WorkflowCheckpoint | null, now: string): boolean {
    if (!validRevision(expectedRevision) || !validToken(claimToken) || !STATES.has(state) || !validCheckpoint(checkpoint) || !validDate(now)) return false;
    try { return this.tx((db) => {
      if (!this.validStoredState(ownerKey, id)) return false;
      const wf = this.owned(db, ownerKey, id);
      const task = this.task(db, id, taskId);
      if (!wf || wf.cancelled || !task || task.claim_token !== claimToken || task.revision !== expectedRevision || !allowed(task.state as WorkflowTaskState, state)) return false;
      db.prepare('UPDATE durable_workflow_tasks SET state=?, revision=revision+1, checkpoint_json=?, claim_token=? WHERE workflow_id=? AND task_id=? AND revision=? AND claim_token=?')
        .run(state, checkpoint === null ? null : JSON.stringify(checkpoint), TERMINAL.has(state) ? null : claimToken, id, taskId, expectedRevision, claimToken);
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
      for (const t of active) {
        db.prepare("UPDATE durable_workflow_tasks SET state='cancelled', revision=revision+1, claim_token=NULL WHERE workflow_id=? AND task_id=?").run(id, t.task_id);
        this.append(db, id, t.task_id, 'cancelled', now, t.revision + 1);
      }
      this.append(db, id, null, 'cancelled', now, null);
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
function allowed(from: WorkflowTaskState, to: WorkflowTaskState): boolean {
  if (from === 'running') return ['running', 'verifying', 'blocked', 'failed', 'cancelled'].includes(to);
  if (from === 'verifying') return ['verifying', 'done', 'failed', 'blocked', 'cancelled'].includes(to);
  return false;
}

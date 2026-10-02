import { err, ok, type Result } from '@baitonghub-linux-mcp/domain';

export type WorkflowRole = 'lead' | 'worker' | 'qa' | 'planner';
export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export interface CodexRunOptions {
  readonly role?: WorkflowRole;
  readonly model?: string;
  readonly effort?: CodexEffort;
}
export interface ResolvedCodexSelection {
  readonly role: WorkflowRole;
  readonly model: string;
  readonly effort: CodexEffort;
}

const defaults: Record<WorkflowRole, { model: string; effort: CodexEffort }> = {
  lead: { model: 'gpt-6.1-sol', effort: 'medium' },
  worker: { model: 'gpt-6-luna', effort: 'low' },
  qa: { model: 'gpt-6.1-sol', effort: 'medium' },
  planner: { model: 'gpt-6-astra', effort: 'low' },
};
const supportedModels = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
const efforts = new Set<CodexEffort>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function resolveCodexSelection(input: unknown): Result<ResolvedCodexSelection | null> {
  if (input === undefined) return ok(null);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length === 0) return ok(null);
  const value = input as Record<string, unknown>;
  if (keys.some((key) => typeof key !== 'string' || !['role', 'model', 'effort'].includes(key))) return invalid();
  if (keys.some((key) => value[key as string] === undefined || value[key as string] === null)) return invalid();

  const role = value.role === undefined ? 'lead' : value.role;
  if (typeof role !== 'string' || !Object.hasOwn(defaults, role)) return invalid();
  const preset = defaults[role as WorkflowRole];
  const model = value.model === undefined ? preset.model : value.model;
  if (typeof model !== 'string' || model.length === 0 || model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) || !supportedModels.has(model)) return invalid();
  const effort = value.effort === undefined ? preset.effort : value.effort;
  if (typeof effort !== 'string' || !efforts.has(effort as CodexEffort)) return invalid();
  if ((model === 'gpt-6-luna' || model === 'gpt-5.6-luna') && effort === 'ultra') return invalid();
  return ok({ role: role as WorkflowRole, model, effort: effort as CodexEffort });
}

function invalid(): Result<never> {
  return err({ code: 'INVALID_INPUT', message: 'Invalid Codex selection', recoverable: false });
}

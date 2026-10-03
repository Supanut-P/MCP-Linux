import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { ProcessManager, createSafeProcessEnvironment, type LogQuery, type ManagedProcess, type ManagedProcessStart, type ProcessLogResult } from '@baitonghub-linux-mcp/process';
import { CodexDiscovery } from './codex-discovery.js';
import { CodexInvocationBuilder, type CodexDiscoveryResult, type CodexInvocation, type CodexStatus } from './codex-capabilities.js';
import { resolveCodexSelection, type CodexRunOptions, type ResolvedCodexSelection } from './codex-selection.js';
import { CodexConfigInspector, type CodexConfigInspectorPort } from './codex-config-inspector.js';
import { DirectCodexSandboxProbe, type CodexSandboxProbePort } from './codex-sandbox-probe.js';

export interface CodexPreflight {
  readonly selection: ResolvedCodexSelection;
  readonly localReady: boolean;
  readonly syntaxReady: boolean;
  readonly authentication: 'unknown';
  readonly accountAvailability: 'unknown';
  readonly evidence: 'cli_help_only';
  readonly reasonCodes: readonly string[];
}
export interface CodexPreflightStatus extends CodexStatus { readonly preflight?: CodexPreflight }

export interface CodexDiscoveryPort {
  discover(signal?: AbortSignal, enhanced?: boolean): Promise<Result<CodexDiscoveryResult>>;
}

export interface CodexProcessManagerPort {
  start(spec: ManagedProcessStart, signal?: AbortSignal, onCreated?: (process: ManagedProcess) => void, environment?: NodeJS.ProcessEnv): Promise<Result<ManagedProcess>>;
  status(processId: string): Result<ManagedProcess>;
  logs(processId: string, query: LogQuery): Result<ProcessLogResult>;
  stop(processId: string, autoRetry?: boolean): Promise<Result<void>>;
}

export interface CodexInvocationBuilderPort {
  build(executable: string, capabilities: CodexDiscoveryResult['capabilities'], instruction: string, options?: CodexRunOptions, writeAllowed?: boolean): Result<CodexInvocation>;
}

export class CodexAdapter {
  private readonly builder: CodexInvocationBuilderPort;

  public constructor(
    private readonly discovery: CodexDiscoveryPort = new CodexDiscovery(),
    private readonly processManager: CodexProcessManagerPort = new ProcessManager(),
    builder: CodexInvocationBuilderPort = new CodexInvocationBuilder(),
    private readonly configInspector: CodexConfigInspectorPort = new CodexConfigInspector(),
    private readonly sandboxProbe: CodexSandboxProbePort = new DirectCodexSandboxProbe(),
  ) {
    this.builder = builder;
  }

  public async status(options?: CodexRunOptions, signal?: AbortSignal): Promise<Result<CodexPreflightStatus>> {
    const selection = resolveCodexSelection(options);
    if (!selection.ok) return selection;
    const discovered = await this.discovery.discover(signal, selection.value !== null);
    if (isAborted(signal)) return cancelledCodexStart();
    if (!discovered.ok) return discovered;
    if (selection.value === null) return ok(discovered.value.status);
    const syntaxReady = discovered.value.status.installed && discovered.value.capabilities.enhanced === true;
    const localReady = false; // status has no workspace against which to verify effective configuration.
    return ok({ ...discovered.value.status, preflight: { selection: selection.value, localReady, syntaxReady, authentication: 'unknown', accountAvailability: 'unknown', evidence: 'cli_help_only', reasonCodes: !syntaxReady ? ['enhanced_controls_unavailable'] : ['workspace_preflight_required'] } });
  }

  public async start(
    cwd: string,
    instruction: string,
    signal?: AbortSignal,
    onCreated?: (process: ManagedProcess) => void,
    options?: CodexRunOptions,
    writeAllowed = false,
  ): Promise<Result<ManagedProcess>> {
    if (isAborted(signal)) return cancelledCodexStart();
    const selection = resolveCodexSelection(options);
    if (!selection.ok) return selection;
    if (selection.value?.role === 'worker' && !writeAllowed) return err(appError('PERMISSION_DENIED', 'Codex worker execution requires independent workspace WRITE permission'));
    const discovered = await this.discovery.discover(signal, selection.value !== null);
    if (isAborted(signal)) return cancelledCodexStart();
    if (!discovered.ok) return discovered;
    if (!discovered.value.status.installed || discovered.value.status.executablePath === undefined) {
      return err({ code: 'CODEX_NOT_AVAILABLE', message: 'Codex is not installed', recoverable: true });
    }
    let capabilities = discovered.value.capabilities;
    const environment = Object.freeze(createSafeProcessEnvironment(process.env));
    if (selection.value !== null) {
      if (capabilities.enhanced !== true) return err(appError('CODEX_NOT_AVAILABLE', 'Codex enhanced invocation controls are unavailable', true));
      const verified = await this.configInspector.verify(discovered.value.status.executablePath, cwd, selection.value.role === 'worker' ? 'workspace-write' : 'read-only', signal, environment);
      if (isAborted(signal)) return cancelledCodexStart();
      if (!verified.ok) return verified;
      const sandbox = selection.value.role === 'worker' ? 'workspace-write' : 'read-only';
      const usable = await this.sandboxProbe.verify(discovered.value.status.executablePath, cwd, sandbox, signal, environment);
      if (isAborted(signal)) return cancelledCodexStart();
      if (!usable.ok) return usable;
      capabilities = { ...capabilities, integrationControlsVerified: true, disabledServerIds: verified.value.disabledServerIds };
    }
    const invocation = selection.value === null
      ? this.builder.build(discovered.value.status.executablePath, discovered.value.capabilities, instruction)
      : this.builder.build(discovered.value.status.executablePath, capabilities, instruction, options, writeAllowed);
    if (!invocation.ok) return invocation;
    if (isAborted(signal)) return cancelledCodexStart();
    return selection.value === null
      ? this.processManager.start({ executable: invocation.value.executable, args: invocation.value.args, cwd }, signal, onCreated)
      : this.processManager.start({ executable: invocation.value.executable, args: invocation.value.args, cwd }, signal, onCreated, environment);
  }

  public statusProcess(processId: string): Result<ManagedProcess> {
    return this.processManager.status(processId);
  }

  public logs(processId: string, query: LogQuery): Result<ProcessLogResult> {
    return this.processManager.logs(processId, query);
  }

  public stop(processId: string, autoRetry = false): Promise<Result<void>> {
    return this.processManager.stop(processId, autoRetry);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledCodexStart(): Result<never> {
  return err({ code: 'PROCESS_TIMEOUT', message: 'Codex start was cancelled before launch completed', recoverable: true });
}

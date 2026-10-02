import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { resolveCodexSelection, type CodexRunOptions } from './codex-selection.js';
import { codexRoleConfig, disabledMcpConfig } from './codex-config-policy.js';

export type CodexInstructionMode = 'exec-argument' | 'prompt-option' | 'positional-argument';

export interface CodexCapabilities {
  readonly instructionMode: CodexInstructionMode | null;
  readonly names: readonly string[];
  readonly enhanced?: boolean;
  /** Set only after target-specific effective integration controls are verified. */
  readonly integrationControlsVerified?: boolean;
  readonly disabledServerIds?: readonly string[];
}

export interface CodexStatus {
  readonly installed: boolean;
  readonly executablePath?: string;
  readonly version?: string;
  readonly capabilities: readonly string[];
}

export interface CodexDiscoveryResult {
  readonly status: CodexStatus;
  readonly capabilities: CodexCapabilities;
}

export interface CodexInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export class CodexInvocationBuilder {
  public build(executable: string, capabilities: CodexCapabilities, instruction: string, options?: CodexRunOptions, writeAllowed = false): Result<CodexInvocation> {
    if (executable.trim().length === 0 || instruction.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Codex executable and instruction are required'));
    }
    if (capabilities.instructionMode === null) {
      return err(appError('CODEX_NOT_AVAILABLE', 'Codex instruction invocation is not supported', true));
    }
    const selection = resolveCodexSelection(options);
    if (!selection.ok) return selection;
    if (selection.value !== null) {
      if (capabilities.instructionMode !== 'exec-argument' || capabilities.enhanced !== true) return err(appError('CODEX_NOT_AVAILABLE', 'Codex enhanced invocation controls are unavailable', true));
      if (capabilities.integrationControlsVerified !== true) return err(appError('CODEX_NOT_AVAILABLE', 'Codex effective integration isolation has not been verified for this workspace', true));
      if (selection.value.role === 'worker' && !writeAllowed) return err(appError('PERMISSION_DENIED', 'Codex worker execution requires independent workspace WRITE permission'));
      const servers = disabledMcpConfig(capabilities.disabledServerIds ?? []);
      if (!servers.ok) return servers;
      return ok({ executable, args: [
        'exec', '--model', selection.value.model, '--config', `model_reasoning_effort=${JSON.stringify(selection.value.effort)}`,
        '--json', '--ephemeral', '--strict-config', '--sandbox', selection.value.role === 'worker' ? 'workspace-write' : 'read-only',
        ...[...codexRoleConfig(selection.value.role === 'worker' ? 'workspace-write' : 'read-only'), ...servers.value].flatMap((value) => ['--config', value]), '--', instruction,
      ] });
    }
    const args = capabilities.instructionMode === 'exec-argument'
      ? ['exec', instruction]
      : capabilities.instructionMode === 'prompt-option'
        ? ['--prompt', instruction]
        : [instruction];
    return ok({ executable, args });
  }
}

export function capabilitiesFromHelp(helpText: string): CodexCapabilities {
  const names: string[] = [];
  if (/\bexec\b/i.test(helpText)) names.push('exec');
  if (/--prompt\b|--instruction\b/i.test(helpText)) names.push('prompt-argument');
  if (/\bprompt\b.*<[^>]+>/i.test(helpText) && !names.includes('prompt-argument')) names.push('positional-instruction');
  const instructionMode = names.includes('exec')
    ? 'exec-argument'
    : names.includes('prompt-argument')
      ? 'prompt-option'
      : names.includes('positional-instruction')
        ? 'positional-argument'
        : null;
  return { instructionMode, names };
}

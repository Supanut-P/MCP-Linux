import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';

export type CodexInstructionMode = 'exec-argument' | 'prompt-option' | 'positional-argument';

export interface CodexCapabilities {
  readonly instructionMode: CodexInstructionMode | null;
  readonly names: readonly string[];
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
  public build(executable: string, capabilities: CodexCapabilities, instruction: string): Result<CodexInvocation> {
    if (executable.trim().length === 0 || instruction.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Codex executable and instruction are required'));
    }
    if (capabilities.instructionMode === null) {
      return err(appError('CODEX_NOT_AVAILABLE', 'Codex instruction invocation is not supported', true));
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

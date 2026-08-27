export type LifecycleHookEvent = 'beforeTool' | 'afterTool' | 'beforeRead' | 'afterRead' | 'beforeWrite' | 'afterWrite' | 'beforeShell' | 'afterShell' | 'beforeGit' | 'afterGit' | 'beforeBrowser' | 'afterBrowser';

export interface LifecycleHookContext {
  readonly event: LifecycleHookEvent;
  readonly toolName: string;
  readonly workspaceId?: string;
  readonly target?: string;
  readonly inputKeys: readonly string[];
}

export interface LifecycleHookResult {
  readonly allow: boolean;
  readonly reason?: string;
  readonly modifiedInput?: unknown;
}

export type LifecycleHookHandler = (context: LifecycleHookContext) => Promise<LifecycleHookResult | void>;

interface RegisteredHook {
  readonly id: string;
  readonly event: LifecycleHookEvent;
  readonly handler: LifecycleHookHandler;
}

export class LifecycleHookRegistry {
  private readonly hooks = new Map<string, RegisteredHook>();

  public register(id: string, event: LifecycleHookEvent, handler: LifecycleHookHandler): void {
    this.hooks.set(id, { id, event, handler });
  }

  public remove(id: string): boolean {
    return this.hooks.delete(id);
  }

  public list(): readonly { readonly id: string; readonly event: LifecycleHookEvent }[] {
    return [...this.hooks.values()].map(({ id, event }) => ({ id, event }));
  }

  public async run(context: LifecycleHookContext): Promise<LifecycleHookResult> {
    let modifiedInput: unknown;
    for (const hook of this.hooks.values()) {
      if (hook.event !== context.event) continue;
      const result = await hook.handler(context);
      if (result?.modifiedInput !== undefined) modifiedInput = result.modifiedInput;
      if (result?.allow === false) return { allow: false, reason: result.reason ?? `hook ${hook.id} denied the operation`, ...(modifiedInput === undefined ? {} : { modifiedInput }) };
    }
    return { allow: true, ...(modifiedInput === undefined ? {} : { modifiedInput }) };
  }
}

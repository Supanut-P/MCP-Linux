import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import { PathExecutableResolver } from '@baitonghub-linux-mcp/process';
import type { NativeCapabilityBackend, NativeCapabilityHealth } from './platform/types.js';
import { XdgPortalProvider } from './xdg-portal-provider.js';
import { AtSpi2Provider } from './at-spi-provider.js';

export type LinuxNativeCapabilityName =
  | 'accessibility'
  | 'input_event'
  | 'vision'
  | 'window'
  | 'system_info'
  | 'notification'
  | 'file_dialog'
  | 'clipboard';

export interface LinuxCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LinuxCommandOptions {
  readonly input?: string;
  readonly signal: AbortSignal | undefined;
}

export type LinuxCommandRunner = (
  executable: string,
  args: readonly string[],
  options: LinuxCommandOptions,
) => Promise<LinuxCommandResult>;

export interface LinuxPortalProvider {
  status(capability: LinuxNativeCapabilityName): Promise<Result<unknown>>;
  screenshot(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>>;
  fileChooser(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>>;
  inputEvent(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>>;
}

export interface LinuxAtSpiProvider {
  status(): Promise<Result<unknown>>;
  execute(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>>;
}

export interface LinuxNativeBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly resolveExecutable?: (name: string) => Promise<string | null>;
  readonly runner?: LinuxCommandRunner;
  readonly portal?: LinuxPortalProvider;
  readonly atSpi?: LinuxAtSpiProvider;
}

type DisplayServer = 'wayland' | 'x11' | 'headless';

export class LinuxNativeCapabilityBackend implements NativeCapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly resolveExecutable: (name: string) => Promise<string | null>;
  private readonly runner: LinuxCommandRunner;
  private readonly portal: LinuxPortalProvider;
  private readonly atSpi: LinuxAtSpiProvider;

  public constructor(
    private readonly capability: LinuxNativeCapabilityName,
    options: LinuxNativeBackendOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.resolveExecutable = options.resolveExecutable ?? resolveExecutable;
    this.runner = options.runner ?? runCommand;
    this.portal = options.portal ?? new XdgPortalProvider();
    this.atSpi = options.atSpi ?? new AtSpi2Provider();
  }

  public async health(): Promise<NativeCapabilityHealth> {
    const displayServer = detectDisplayServer(this.environment);
    if (this.platform !== 'linux') {
      return { platform: this.platform, displayServer, available: false, ready: false, reason: 'platform_unsupported' };
    }

    if (this.capability === 'system_info') {
      return health(this.platform, displayServer, 'node', true, false, []);
    }
    if (displayServer === 'headless') {
      return health(this.platform, displayServer, 'none', false, false, [], 'display_session_unavailable');
    }
    if (this.capability === 'accessibility') {
      return this.delegatedHealth(displayServer, 'at-spi2', await this.atSpi.status(), false);
    }
    if (this.capability === 'file_dialog' || (displayServer === 'wayland' && ['vision', 'input_event'].includes(this.capability))) {
      return this.delegatedHealth(displayServer, 'xdg-desktop-portal', await this.portal.status(this.capability), true);
    }

    const dependencyNames = dependenciesFor(this.capability, displayServer);
    const resolved = await Promise.all(dependencyNames.map(async (name) => ({ name, value: await this.resolveExecutable(name) })));
    const missing = resolved.filter((item) => item.value === null).map((item) => item.name);
    return health(
      this.platform,
      displayServer,
      providerFor(this.capability, displayServer),
      missing.length === 0,
      false,
      missing,
      missing.length === 0 ? undefined : 'missing_dependencies',
    );
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('PLATFORM_UNSUPPORTED', 'Linux capability is unavailable on this platform', true));
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Linux native capability input must be an object'));
    if (isStatusRequest(input)) return ok(await this.health());
    if (input.dry_run === true) return ok({ dry_run: true, capability: this.capability, platform: 'linux' });
    if (signal?.aborted) return cancelled();

    const displayServer = detectDisplayServer(this.environment);
    switch (this.capability) {
      case 'system_info': return ok(systemInformation(input));
      case 'notification': return this.notification(input, signal);
      case 'clipboard': return this.clipboard(input, displayServer, signal);
      case 'file_dialog': return this.portal.fileChooser(input, signal);
      case 'vision': return this.vision(input, displayServer, signal);
      case 'input_event': return this.inputEvent(input, displayServer, signal);
      case 'window': return this.window(input, displayServer, signal);
      case 'accessibility': return this.atSpi.execute(input, signal);
    }
  }

  private async notification(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    const title = readString(input.title);
    const message = readString(input.message);
    if (title === undefined || message === undefined) return invalid('Notification title and message are required');
    const executable = await this.requireExecutable('notify-send');
    if (!executable.ok) return executable;
    const result = await this.runner(executable.value, ['--app-name=Baitonghub-Linux-mcp', title, message], { signal });
    return commandResult(result, { shown: true, provider: 'org.freedesktop.Notifications' });
  }

  private async clipboard(
    input: Readonly<Record<string, unknown>>,
    displayServer: DisplayServer,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    const action = input.action;
    if (action !== 'get_text' && action !== 'set_text' && action !== 'get_image') return invalid('Clipboard action is invalid');
    const wayland = displayServer === 'wayland';
    const executableName = wayland ? (action === 'set_text' ? 'wl-copy' : 'wl-paste') : 'xclip';
    const executable = await this.requireExecutable(executableName);
    if (!executable.ok) return executable;
    const args = wayland
      ? action === 'get_image' ? ['--no-newline', '--type', 'image/png'] : action === 'get_text' ? ['--no-newline'] : []
      : action === 'get_image' ? ['-selection', 'clipboard', '-target', 'image/png', '-out'] : action === 'get_text' ? ['-selection', 'clipboard', '-out'] : ['-selection', 'clipboard', '-in'];
    const text = action === 'set_text' ? readString(input.text, true) : undefined;
    if (action === 'set_text' && text === undefined) return invalid('Clipboard text is required');
    const result = await this.runner(executable.value, args, { ...(text === undefined ? {} : { input: text }), signal });
    if (result.exitCode !== 0) return unavailable('Clipboard provider failed');
    if (action === 'set_text') return ok({ written: true, provider: wayland ? 'wl-clipboard' : 'xclip' });
    return ok(action === 'get_image'
      ? { image_base64: Buffer.from(result.stdout, 'binary').toString('base64'), provider: wayland ? 'wl-clipboard' : 'xclip' }
      : { text: result.stdout, provider: wayland ? 'wl-clipboard' : 'xclip' });
  }

  private async vision(
    input: Readonly<Record<string, unknown>>,
    displayServer: DisplayServer,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    if (input.action === 'ocr') return this.ocr(input, signal);
    if (displayServer === 'wayland') return this.portal.screenshot(input, signal);
    if (displayServer !== 'x11') return unavailable('A graphical display session is required');
    if (input.action !== 'capture_display') return unavailable('This X11 capture operation is unavailable');
    const executable = await this.requireExecutable('gnome-screenshot');
    if (!executable.ok) return executable;
    const target = path.join(os.tmpdir(), `baitonghub-linux-mcp-${randomUUID()}.png`);
    try {
      const result = await this.runner(executable.value, ['--file', target], { signal });
      if (result.exitCode !== 0) return unavailable('X11 screenshot provider failed');
      return ok({ image_base64: (await readFile(target)).toString('base64'), provider: 'gnome-screenshot' });
    } finally {
      await rm(target, { force: true }).catch(() => undefined);
    }
  }

  private async ocr(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    const imageBase64 = readString(input.image_base64);
    if (imageBase64 === undefined) return invalid('OCR image_base64 is required');
    const executable = await this.requireExecutable('tesseract');
    if (!executable.ok) return executable;
    const target = path.join(os.tmpdir(), `baitonghub-linux-mcp-ocr-${randomUUID()}.png`);
    try {
      await writeFile(target, Buffer.from(imageBase64, 'base64'), { mode: 0o600 });
      const result = await this.runner(executable.value, [target, 'stdout'], { signal });
      if (result.exitCode !== 0) return unavailable('Tesseract OCR failed');
      return ok({ text: result.stdout, provider: 'tesseract' });
    } finally {
      await rm(target, { force: true }).catch(() => undefined);
    }
  }

  private async inputEvent(
    input: Readonly<Record<string, unknown>>,
    displayServer: DisplayServer,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    if (input.userConfirmed !== true) {
      return err(appError('CAPABILITY_CONSENT_REQUIRED', 'Input automation requires explicit user confirmation and OS consent', true));
    }
    if (displayServer === 'wayland') return this.portal.inputEvent(input, signal);
    if (displayServer !== 'x11') return unavailable('A graphical display session is required');
    const executable = await this.requireExecutable('xdotool');
    if (!executable.ok) return executable;
    const args = xdotoolArguments(input);
    if (!args.ok) return args;
    return commandResult(await this.runner(executable.value, args.value, { signal }), { injected: true, provider: 'xdotool' });
  }

  private async window(
    input: Readonly<Record<string, unknown>>,
    displayServer: DisplayServer,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    if (displayServer === 'wayland') return unavailable('The active Wayland compositor does not expose this window operation');
    if (displayServer !== 'x11') return unavailable('A graphical display session is required');
    const operation = input.operation;
    const parameters = isRecord(input.parameters) ? input.parameters : {};
    const wmctrl = await this.requireExecutable('wmctrl');
    if (!wmctrl.ok) return wmctrl;
    if (operation === 'list') {
      const result = await this.runner(wmctrl.value, ['-lpGx'], { signal });
      return result.exitCode === 0 ? ok({ windows: parseWmctrl(result.stdout), provider: 'wmctrl' }) : unavailable('X11 window provider failed');
    }
    const id = readString(parameters.id) ?? readString(parameters.window_id);
    if (id === undefined) return invalid('Window id is required');
    const args = wmctrlArguments(operation, id, parameters);
    if (!args.ok) return args;
    return commandResult(await this.runner(wmctrl.value, args.value, { signal }), { changed: true, provider: 'wmctrl' });
  }

  private async requireExecutable(name: string): Promise<Result<string>> {
    const executable = await this.resolveExecutable(name);
    return executable === null
      ? err(appError('CAPABILITY_UNAVAILABLE', `Required Linux dependency is unavailable: ${name}`, true))
      : ok(executable);
  }

  private async delegatedHealth(
    displayServer: DisplayServer,
    provider: string,
    result: Result<unknown>,
    requiresConsent: boolean,
  ): Promise<NativeCapabilityHealth> {
    if (!result.ok) return health(this.platform, displayServer, provider, false, requiresConsent, [], result.error.code.toLowerCase());
    const value = isRecord(result.value) ? result.value : {};
    const available = value.available !== false;
    const ready = value.ready !== false;
    return {
      platform: this.platform,
      displayServer,
      provider: readString(value.provider) ?? provider,
      available,
      ready,
      requiresConsent: value.requiresConsent === true || requiresConsent,
      missingDependencies: stringArray(value.missingDependencies),
      ...(!available && typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
  }
}

function health(
  platform: NodeJS.Platform,
  displayServer: DisplayServer,
  provider: string,
  ready: boolean,
  requiresConsent: boolean,
  missingDependencies: readonly string[],
  reason?: string,
): NativeCapabilityHealth {
  return {
    platform,
    displayServer,
    provider,
    available: ready,
    ready,
    requiresConsent,
    missingDependencies,
    ...(reason === undefined ? {} : { reason }),
  };
}

function dependenciesFor(capability: LinuxNativeCapabilityName, displayServer: DisplayServer): readonly string[] {
  if (capability === 'clipboard') return displayServer === 'wayland' ? ['wl-copy', 'wl-paste'] : ['xclip'];
  if (capability === 'notification') return ['notify-send'];
  if (capability === 'vision') return displayServer === 'x11' ? ['gnome-screenshot', 'tesseract'] : ['tesseract'];
  if (capability === 'input_event') return displayServer === 'x11' ? ['xdotool'] : [];
  if (capability === 'window') return displayServer === 'x11' ? ['wmctrl'] : [];
  return [];
}

function providerFor(capability: LinuxNativeCapabilityName, displayServer: DisplayServer): string {
  if (capability === 'clipboard') return displayServer === 'wayland' ? 'wl-clipboard' : 'xclip';
  if (capability === 'notification') return 'org.freedesktop.Notifications';
  if (capability === 'vision') return displayServer === 'wayland' ? 'xdg-desktop-portal' : 'gnome-screenshot';
  if (capability === 'input_event') return displayServer === 'wayland' ? 'xdg-desktop-portal' : 'xdotool';
  if (capability === 'window') return displayServer === 'wayland' ? 'compositor' : 'wmctrl';
  return capability;
}

function detectDisplayServer(environment: Readonly<Record<string, string | undefined>>): DisplayServer {
  if (environment.WAYLAND_DISPLAY?.trim()) return 'wayland';
  if (environment.DISPLAY?.trim()) return 'x11';
  return 'headless';
}

function systemInformation(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const operation = input.operation ?? 'all';
  const all = {
    os: { platform: os.platform(), release: os.release(), architecture: os.arch(), hostname: os.hostname() },
    cpu: { model: os.cpus()[0]?.model ?? 'unknown', logical_count: os.cpus().length, load_average: os.loadavg() },
    memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
    uptime_seconds: os.uptime(),
  };
  if (operation === 'os') return all.os;
  if (operation === 'cpu') return all.cpu;
  if (operation === 'memory') return all.memory;
  if (operation === 'uptime') return { uptime_seconds: all.uptime_seconds };
  if (operation === 'disks' || operation === 'battery' || operation === 'processes') return { available: false, reason: 'provider_not_configured' };
  return all;
}

function xdotoolArguments(input: Readonly<Record<string, unknown>>): Result<readonly string[]> {
  const operation = input.operation;
  const parameters = isRecord(input.parameters) ? input.parameters : {};
  if (operation === 'type_text' || operation === 'paste_text') {
    const text = readString(parameters.text, true);
    return text === undefined ? invalid('Input text is required') : ok(['type', '--clearmodifiers', '--', text]);
  }
  if (operation === 'press_key') {
    const key = readString(parameters.key);
    return key === undefined ? invalid('Input key is required') : ok(['key', '--clearmodifiers', key]);
  }
  if (operation === 'hotkey') {
    const keys = stringArray(parameters.keys);
    return keys.length === 0 ? invalid('Hotkey keys are required') : ok(['key', '--clearmodifiers', keys.join('+')]);
  }
  if (operation === 'mouse_move') {
    const coordinates = coordinatesOf(parameters);
    return coordinates === undefined ? invalid('Pointer coordinates are required') : ok(['mousemove', String(coordinates.x), String(coordinates.y)]);
  }
  if (operation === 'click' || operation === 'double_click' || operation === 'right_click') {
    const button = operation === 'right_click' ? '3' : '1';
    return ok(operation === 'double_click' ? ['click', '--repeat', '2', button] : ['click', button]);
  }
  if (operation === 'scroll') {
    const amount = readNumber(parameters.amount) ?? readNumber(parameters.delta_y);
    if (amount === undefined || amount === 0) return invalid('Scroll amount is required');
    return ok(['click', '--repeat', String(Math.min(100, Math.abs(Math.round(amount)))), amount < 0 ? '4' : '5']);
  }
  return err(appError('CAPABILITY_UNAVAILABLE', 'This X11 input operation is unavailable', true));
}

function wmctrlArguments(operation: unknown, id: string, parameters: Readonly<Record<string, unknown>>): Result<readonly string[]> {
  if (operation === 'activate') return ok(['-i', '-a', id]);
  if (operation === 'close') return ok(['-i', '-c', id]);
  if (operation === 'minimize') return ok(['-i', '-r', id, '-b', 'add,hidden']);
  if (operation === 'maximize') return ok(['-i', '-r', id, '-b', 'add,maximized_vert,maximized_horz']);
  if (operation === 'restore') return ok(['-i', '-r', id, '-b', 'remove,hidden,maximized_vert,maximized_horz']);
  if (operation === 'move' || operation === 'resize' || operation === 'set_window_frame') {
    const x = readNumber(parameters.x) ?? -1;
    const y = readNumber(parameters.y) ?? -1;
    const width = readNumber(parameters.width) ?? -1;
    const height = readNumber(parameters.height) ?? -1;
    return ok(['-i', '-r', id, '-e', `0,${x},${y},${width},${height}`]);
  }
  return err(appError('CAPABILITY_UNAVAILABLE', 'This X11 window operation is unavailable', true));
}

function parseWmctrl(stdout: string): readonly Readonly<Record<string, unknown>>[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^(0x[0-9a-f]+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/i.exec(line.trim());
    return match === null ? [] : [{
      id: match[1], desktop: Number(match[2]), pid: Number(match[3]), x: Number(match[4]),
      y: Number(match[5]), width: Number(match[6]), class: match[7], host: match[8], title: match[9],
    }];
  });
}

async function resolveExecutable(name: string): Promise<string | null> {
  const result = await new PathExecutableResolver().resolve(name);
  return result.ok ? result.value : null;
}

function runCommand(executable: string, args: readonly string[], options: LinuxCommandOptions): Promise<LinuxCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('binary'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

function commandResult(result: LinuxCommandResult, value: unknown): Result<unknown> {
  return result.exitCode === 0 ? ok(value) : unavailable('Linux native provider failed');
}

function isStatusRequest(input: Readonly<Record<string, unknown>>): boolean {
  return input.action === 'status' || input.operation === 'status';
}

function coordinatesOf(value: Readonly<Record<string, unknown>>): { readonly x: number; readonly y: number } | undefined {
  const x = readNumber(value.x);
  const y = readNumber(value.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function readString(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  return allowEmpty || value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function invalid(message: string): Result<never> {
  return err(appError('INVALID_INPUT', message));
}

function unavailable(message: string): Result<never> {
  return err(appError('CAPABILITY_UNAVAILABLE', message, true));
}

function cancelled(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Linux native capability operation was cancelled', true));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

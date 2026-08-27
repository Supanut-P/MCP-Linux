import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sessionBus, Variant, type ClientInterface, type MessageBus } from 'dbus-next';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { LinuxNativeCapabilityName, LinuxPortalProvider } from './linux-native-backend.js';

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const REQUEST_INTERFACE = 'org.freedesktop.portal.Request';
const DEFAULT_STATUS_TIMEOUT_MS = 2_000;

export interface XdgPortalTransport {
  available(interfaceName: string): Promise<boolean>;
  request(
    interfaceName: string,
    method: string,
    args: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
  call(interfaceName: string, method: string, args: readonly unknown[]): Promise<void>;
}

export interface XdgPortalProviderOptions {
  readonly transport?: XdgPortalTransport;
  readonly statusTimeoutMs?: number;
}

/** XDG Desktop Portal provider for Wayland screenshot, file chooser, and input consent. */
export class XdgPortalProvider implements LinuxPortalProvider {
  private readonly transport: XdgPortalTransport;
  private readonly statusTimeoutMs: number;
  private remoteDesktopSession: string | undefined;

  public constructor(options: XdgPortalProviderOptions = {}) {
    this.transport = options.transport ?? new DbusPortalTransport();
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  }

  public async status(capability: LinuxNativeCapabilityName): Promise<Result<unknown>> {
    const interfaceName = portalInterface(capability);
    if (interfaceName === undefined) return portalUnavailable('Portal interface is not applicable');
    try {
      const available = await withTimeout(this.transport.available(interfaceName), this.statusTimeoutMs, 'portal_status_timeout');
      return ok({
        platform: 'linux',
        provider: 'xdg-desktop-portal',
        available,
        ready: available,
        requiresConsent: capability === 'vision' || capability === 'file_dialog' || capability === 'input_event',
        missingDependencies: available ? [] : ['xdg-desktop-portal'],
        ...(available ? {} : { reason: 'portal_interface_unavailable' }),
      });
    } catch {
      return portalUnavailable('XDG Desktop Portal is unavailable');
    }
  }

  public async screenshot(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    if (!['capture_display', 'capture_region', 'capture_window'].includes(String(input.action))) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'This portal screenshot operation is unavailable', true));
    }
    try {
      const result = await this.transport.request('org.freedesktop.portal.Screenshot', 'Screenshot', [
        '',
        variants({ interactive: true, modal: true }),
      ], signal);
      const uri = readVariantString(result.uri);
      if (uri === undefined || !uri.startsWith('file:')) return portalUnavailable('Screenshot portal returned no local image');
      return ok({ image_base64: (await readFile(fileURLToPath(uri))).toString('base64'), uri, provider: 'xdg-desktop-portal' });
    } catch (error: unknown) {
      return portalFailure(error, 'Screenshot portal request failed');
    }
  }

  public async fileChooser(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    const action = input.action;
    if (action !== 'open' && action !== 'save') return err(appError('INVALID_INPUT', 'File chooser action is invalid'));
    const options: Record<string, Variant> = {
      handle_token: new Variant('s', portalToken()),
      modal: new Variant('b', true),
      multiple: new Variant('b', action === 'open' && input.multi_select === true),
    };
    const directory = typeof input.initial_directory === 'string' ? input.initial_directory.trim() : '';
    if (directory) options.current_folder = new Variant('ay', [...Buffer.from(`${directory}\0`, 'utf8')]);
    const fileName = typeof input.file_name === 'string' ? input.file_name.trim() : '';
    if (fileName) options.current_name = new Variant('s', fileName);
    try {
      const result = await this.transport.request('org.freedesktop.portal.FileChooser', action === 'open' ? 'OpenFile' : 'SaveFile', [
        '',
        action === 'open' ? 'Open file' : 'Save file',
        options,
      ], signal);
      const uris = readVariantStringArray(result.uris);
      return ok({ cancelled: uris.length === 0, uris, paths: uris.filter((uri) => uri.startsWith('file:')).map((uri) => fileURLToPath(uri)), provider: 'xdg-desktop-portal' });
    } catch (error: unknown) {
      return portalFailure(error, 'File chooser portal request failed');
    }
  }

  public async inputEvent(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    try {
      const session = await this.ensureRemoteDesktopSession(signal);
      const parameters = isRecord(input.parameters) ? input.parameters : {};
      const operation = input.operation;
      if (operation === 'mouse_move') {
        const x = readFiniteNumber(parameters.x);
        const y = readFiniteNumber(parameters.y);
        if (x === undefined || y === undefined) return err(appError('INVALID_INPUT', 'Pointer coordinates are required'));
        await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyPointerMotion', [session, {}, x, y]);
      } else if (operation === 'type_text' || operation === 'paste_text') {
        const text = typeof parameters.text === 'string' ? parameters.text : undefined;
        if (text === undefined) return err(appError('INVALID_INPUT', 'Input text is required'));
        for (const character of text) await this.sendKeysym(session, unicodeKeysym(character));
      } else if (operation === 'press_key' || operation === 'key_down' || operation === 'key_up') {
        const key = typeof parameters.key === 'string' ? parameters.key : undefined;
        const keysym = key === undefined ? undefined : namedKeysym(key);
        if (keysym === undefined) return err(appError('INVALID_INPUT', 'Input key is invalid'));
        if (operation !== 'key_up') await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyKeyboardKeysym', [session, {}, keysym, 1]);
        if (operation !== 'key_down') await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyKeyboardKeysym', [session, {}, keysym, 0]);
      } else if (operation === 'hotkey') {
        const keys = Array.isArray(parameters.keys) ? parameters.keys.filter((key): key is string => typeof key === 'string') : [];
        const keysyms = keys.map(namedKeysym);
        if (keysyms.length === 0 || keysyms.some((value) => value === undefined)) return err(appError('INVALID_INPUT', 'Hotkey keys are invalid'));
        for (const keysym of keysyms) await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyKeyboardKeysym', [session, {}, keysym!, 1]);
        for (const keysym of [...keysyms].reverse()) await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyKeyboardKeysym', [session, {}, keysym!, 0]);
      } else if (operation === 'click' || operation === 'double_click' || operation === 'right_click') {
        const button = operation === 'right_click' ? 273 : 272;
        const count = operation === 'double_click' ? 2 : 1;
        for (let index = 0; index < count; index += 1) {
          await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyPointerButton', [session, {}, button, 1]);
          await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyPointerButton', [session, {}, button, 0]);
        }
      } else if (operation === 'scroll') {
        const deltaX = readFiniteNumber(parameters.delta_x) ?? 0;
        const deltaY = readFiniteNumber(parameters.delta_y) ?? readFiniteNumber(parameters.amount);
        if (deltaY === undefined) return err(appError('INVALID_INPUT', 'Scroll amount is required'));
        await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyPointerAxis', [session, {}, deltaX, deltaY]);
      } else {
        return err(appError('CAPABILITY_UNAVAILABLE', 'This Wayland input operation is unavailable', true));
      }
      return ok({ injected: true, provider: 'xdg-desktop-portal', requiresConsent: true });
    } catch (error: unknown) {
      return portalFailure(error, 'RemoteDesktop portal consent was denied or unavailable', true);
    }
  }

  private async sendKeysym(session: string, keysym: number): Promise<void> {
    await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyKeyboardKeysym', [session, {}, keysym, 1]);
    await this.transport.call('org.freedesktop.portal.RemoteDesktop', 'NotifyKeyboardKeysym', [session, {}, keysym, 0]);
  }

  private async ensureRemoteDesktopSession(signal?: AbortSignal): Promise<string> {
    if (this.remoteDesktopSession !== undefined) return this.remoteDesktopSession;
    const created = await this.transport.request('org.freedesktop.portal.RemoteDesktop', 'CreateSession', [variants({
      handle_token: portalToken(),
      session_handle_token: portalToken(),
    })], signal);
    const session = readVariantString(created.session_handle);
    if (session === undefined) throw new Error('portal_session_missing');
    await this.transport.request('org.freedesktop.portal.RemoteDesktop', 'SelectDevices', [session, variants({
      handle_token: portalToken(),
      types: 3,
      persist_mode: 0,
    })], signal);
    await this.transport.request('org.freedesktop.portal.RemoteDesktop', 'Start', [session, '', variants({ handle_token: portalToken() })], signal);
    this.remoteDesktopSession = session;
    return session;
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export class DbusPortalTransport implements XdgPortalTransport {
  private bus: MessageBus | undefined;

  public constructor(bus?: MessageBus) {
    this.bus = bus;
  }

  public async available(interfaceName: string): Promise<boolean> {
    const object = await this.getBus().getProxyObject(PORTAL_NAME, PORTAL_PATH);
    return object.interfaces[interfaceName] !== undefined;
  }

  public async request(
    interfaceName: string,
    method: string,
    args: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (signal?.aborted) throw new Error('portal_request_cancelled');
    const bus = this.getBus();
    const object = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
    const portal = object.getInterface(interfaceName);
    const requestPath = await invoke(portal, method, args);
    if (typeof requestPath !== 'string') throw new Error('portal_request_path_missing');
    const requestObject = await bus.getProxyObject(PORTAL_NAME, requestPath);
    const request = requestObject.getInterface(REQUEST_INTERFACE);
    return waitForPortalResponse(request, signal);
  }

  public async call(interfaceName: string, method: string, args: readonly unknown[]): Promise<void> {
    const object = await this.getBus().getProxyObject(PORTAL_NAME, PORTAL_PATH);
    await invoke(object.getInterface(interfaceName), method, args);
  }

  private getBus(): MessageBus {
    if (this.bus === undefined) {
      this.bus = sessionBus();
      this.bus.on('error', () => undefined);
    }
    return this.bus;
  }
}

function waitForPortalResponse(request: ClientInterface, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      request.removeListener('Response', onResponse);
      signal?.removeEventListener('abort', onAbort);
    };
    const onResponse = (response: unknown, results: unknown): void => {
      cleanup();
      if (response !== 0) {
        reject(new Error(response === 1 ? 'portal_cancelled' : 'portal_denied'));
        return;
      }
      resolve(isRecord(results) ? results : {});
    };
    const onAbort = (): void => { cleanup(); reject(new Error('portal_request_cancelled')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('portal_request_timeout')); }, 120_000);
    request.once('Response', onResponse);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function invoke(target: ClientInterface, method: string, args: readonly unknown[]): Promise<unknown> {
  const operation = target[method];
  if (typeof operation !== 'function') throw new Error('portal_method_unavailable');
  return operation.apply(target, args);
}

function variants(values: Readonly<Record<string, string | number | boolean>>): Record<string, Variant> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, new Variant(
    typeof value === 'boolean' ? 'b' : typeof value === 'number' ? 'u' : 's',
    value,
  )]));
}

function portalInterface(capability: LinuxNativeCapabilityName): string | undefined {
  if (capability === 'vision') return 'org.freedesktop.portal.Screenshot';
  if (capability === 'file_dialog') return 'org.freedesktop.portal.FileChooser';
  if (capability === 'input_event') return 'org.freedesktop.portal.RemoteDesktop';
  return undefined;
}

function portalToken(): string {
  return `baitonghub_${randomUUID().replaceAll('-', '')}`;
}

function readVariantString(value: unknown): string | undefined {
  const unwrapped = value instanceof Variant ? value.value : value;
  return typeof unwrapped === 'string' && unwrapped.length > 0 ? unwrapped : undefined;
}

function readVariantStringArray(value: unknown): readonly string[] {
  const unwrapped = value instanceof Variant ? value.value : value;
  return Array.isArray(unwrapped) ? unwrapped.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const NAMED_KEYSYMS: Readonly<Record<string, number>> = {
  enter: 0xff0d,
  return: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  tab: 0xff09,
  backspace: 0xff08,
  delete: 0xffff,
  space: 0x20,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  shift: 0xffe1,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  super: 0xffeb,
  meta: 0xffe7,
};

function namedKeysym(key: string): number | undefined {
  const normalized = key.trim().toLocaleLowerCase();
  if (/^f(?:[1-9]|1[0-2])$/.test(normalized)) return 0xffbd + Number(normalized.slice(1));
  if (normalized.length === 1) return unicodeKeysym(normalized);
  return NAMED_KEYSYMS[normalized];
}

function unicodeKeysym(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
}

function portalFailure(error: unknown, message: string, consent = false): Result<never> {
  const cancelled = error instanceof Error && error.message === 'portal_cancelled';
  return err(appError(
    consent || cancelled ? 'CAPABILITY_CONSENT_REQUIRED' : 'CAPABILITY_UNAVAILABLE',
    message,
    true,
  ));
}

function portalUnavailable(message: string): Result<never> {
  return err(appError('CAPABILITY_UNAVAILABLE', message, true));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

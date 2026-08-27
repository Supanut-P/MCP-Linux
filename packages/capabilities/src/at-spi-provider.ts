import { sessionBus, Variant, type ClientInterface, type MessageBus } from 'dbus-next';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { LinuxAtSpiProvider } from './linux-native-backend.js';

const ACCESSIBLE_INTERFACE = 'org.a11y.atspi.Accessible';
const COMPONENT_INTERFACE = 'org.a11y.atspi.Component';
const ACTION_INTERFACE = 'org.a11y.atspi.Action';
const EDITABLE_TEXT_INTERFACE = 'org.a11y.atspi.EditableText';
const VALUE_INTERFACE = 'org.a11y.atspi.Value';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const ROOT = { busName: 'org.a11y.atspi.Registry', objectPath: '/org/a11y/atspi/accessible/root' };
const DEFAULT_STATUS_TIMEOUT_MS = 2_000;

export interface AtSpiTarget {
  readonly busName: string;
  readonly objectPath: string;
}

export interface AtSpiNode extends AtSpiTarget {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly role: string;
  readonly interfaces: readonly string[];
  readonly children: readonly AtSpiNode[];
}

export interface AtSpiTransport {
  available(): Promise<boolean>;
  snapshot(maxDepth: number, maxNodes: number): Promise<AtSpiNode>;
  invoke(action: string, target: AtSpiTarget, value?: string): Promise<unknown>;
}

export interface AtSpi2ProviderOptions {
  readonly transport?: AtSpiTransport;
  readonly statusTimeoutMs?: number;
}

/** AT-SPI2 semantic automation provider over the accessibility D-Bus. */
export class AtSpi2Provider implements LinuxAtSpiProvider {
  private readonly transport: AtSpiTransport;
  private readonly statusTimeoutMs: number;

  public constructor(options: AtSpi2ProviderOptions = {}) {
    this.transport = options.transport ?? new DbusAtSpiTransport();
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  }

  public async status(): Promise<Result<unknown>> {
    try {
      const available = await withTimeout(this.transport.available(), this.statusTimeoutMs, 'atspi_status_timeout');
      return ok({
        platform: 'linux',
        provider: 'at-spi2',
        available,
        ready: available,
        requiresConsent: false,
        missingDependencies: available ? [] : ['at-spi2-core'],
        ...(available ? {} : { reason: 'accessibility_bus_unavailable' }),
      });
    } catch {
      return atSpiUnavailable('AT-SPI2 accessibility bus is unavailable');
    }
  }

  public async execute(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'AT-SPI operation was cancelled', true));
    if (input.action === 'status') return this.status();
    try {
      const maxDepth = boundedInteger(input.parameters, 'max_depth', 0, 12, 4);
      const maxNodes = boundedInteger(input.parameters, 'max_nodes', 1, 2_000, 500);
      if (['observe', 'observe_summary', 'observe_changes', 'inspect_elements', 'list_windows'].includes(String(input.action))) {
        return ok({ tree: await this.transport.snapshot(maxDepth, maxNodes), provider: 'at-spi2' });
      }
      if (input.action === 'find_element') {
        const query = readString(record(input.parameters).name) ?? readString(record(input.parameters).query);
        if (query === undefined) return err(appError('INVALID_INPUT', 'Accessibility element name is required'));
        const root = await this.transport.snapshot(maxDepth, maxNodes);
        const matches = flatten(root).filter((node) => node.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        return ok({ elements: matches, provider: 'at-spi2' });
      }
      const target = targetFrom(record(input.parameters));
      if (target === undefined) return err(appError('INVALID_INPUT', 'AT-SPI bus_name and object_path are required'));
      const value = readString(record(input.parameters).value, true);
      const result = await this.transport.invoke(String(input.action), target, value);
      return ok({ result, provider: 'at-spi2', target });
    } catch {
      return atSpiUnavailable('AT-SPI2 operation failed');
    }
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

export class DbusAtSpiTransport implements AtSpiTransport {
  private accessibilityBus: MessageBus | undefined;
  private nodeCount = 0;

  public async available(): Promise<boolean> {
    await this.getAccessibilityBus();
    return true;
  }

  public async snapshot(maxDepth: number, maxNodes: number): Promise<AtSpiNode> {
    this.nodeCount = 0;
    return this.readNode(ROOT, 0, maxDepth, maxNodes);
  }

  public async invoke(action: string, target: AtSpiTarget, value?: string): Promise<unknown> {
    const bus = await this.getAccessibilityBus();
    const object = await bus.getProxyObject(target.busName, target.objectPath);
    if (action === 'focus') return call(object.getInterface(COMPONENT_INTERFACE), 'GrabFocus', []);
    if (action === 'click' || action === 'select_item' || action === 'menu_select') {
      const actions = await call(object.getInterface(ACTION_INTERFACE), 'GetActions', []);
      const index = findActionIndex(actions, action === 'click' ? ['click', 'press', 'activate'] : ['select', 'click', 'press']);
      if (index < 0) throw new Error('atspi_action_unavailable');
      return call(object.getInterface(ACTION_INTERFACE), 'DoAction', [index]);
    }
    if (action === 'read_value') {
      return readProperty(object.getInterface(PROPERTIES_INTERFACE), VALUE_INTERFACE, 'CurrentValue');
    }
    if (action === 'set_value') {
      if (value === undefined) throw new Error('atspi_value_missing');
      if (object.interfaces[EDITABLE_TEXT_INTERFACE] !== undefined) {
        return call(object.getInterface(EDITABLE_TEXT_INTERFACE), 'SetTextContents', [value]);
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) throw new Error('atspi_numeric_value_required');
      return call(object.getInterface(PROPERTIES_INTERFACE), 'Set', [VALUE_INTERFACE, 'CurrentValue', new Variant('d', numeric)]);
    }
    throw new Error('atspi_operation_unavailable');
  }

  private async readNode(target: AtSpiTarget, depth: number, maxDepth: number, maxNodes: number): Promise<AtSpiNode> {
    this.nodeCount += 1;
    const bus = await this.getAccessibilityBus();
    const object = await bus.getProxyObject(target.busName, target.objectPath);
    const accessible = object.getInterface(ACCESSIBLE_INTERFACE);
    const properties = object.getInterface(PROPERTIES_INTERFACE);
    const [all, role] = await Promise.all([
      call(properties, 'GetAll', [ACCESSIBLE_INTERFACE]),
      call(accessible, 'GetRoleName', []).catch(() => 'unknown'),
    ]);
    const values = unwrapRecord(all);
    const children: AtSpiNode[] = [];
    if (depth < maxDepth && this.nodeCount < maxNodes) {
      const references = toTargets(await call(accessible, 'GetChildren', []).catch(() => []));
      for (const child of references) {
        if (this.nodeCount >= maxNodes) break;
        children.push(await this.readNode(child, depth + 1, maxDepth, maxNodes));
      }
    }
    return {
      ...target,
      id: `${target.busName}|${target.objectPath}`,
      name: variantString(values.Name),
      description: variantString(values.Description),
      role: typeof role === 'string' ? role : 'unknown',
      interfaces: variantStringArray(values.Interfaces),
      children,
    };
  }

  private async getAccessibilityBus(): Promise<MessageBus> {
    if (this.accessibilityBus !== undefined) return this.accessibilityBus;
    const desktopBus = sessionBus();
    desktopBus.on('error', () => undefined);
    try {
      const object = await desktopBus.getProxyObject('org.a11y.Bus', '/org/a11y/bus');
      const addressValue = await call(object.getInterface(PROPERTIES_INTERFACE), 'Get', ['org.a11y.Bus', 'Address']);
      const address = variantString(addressValue);
      if (!address) throw new Error('atspi_bus_address_missing');
      this.accessibilityBus = sessionBus({ busAddress: address });
      this.accessibilityBus.on('error', () => undefined);
      return this.accessibilityBus;
    } finally {
      desktopBus.disconnect();
    }
  }
}

async function call(target: ClientInterface, method: string, args: readonly unknown[]): Promise<unknown> {
  const operation = target[method];
  if (typeof operation !== 'function') throw new Error('atspi_method_unavailable');
  return operation.apply(target, args);
}

async function readProperty(target: ClientInterface, interfaceName: string, property: string): Promise<unknown> {
  const value = await call(target, 'Get', [interfaceName, property]);
  return value instanceof Variant ? value.value : value;
}

function targetFrom(parameters: Readonly<Record<string, unknown>>): AtSpiTarget | undefined {
  const busName = readString(parameters.bus_name) ?? readString(parameters.busName);
  const objectPath = readString(parameters.object_path) ?? readString(parameters.objectPath);
  return busName === undefined || objectPath === undefined ? undefined : { busName, objectPath };
}

function toTargets(value: unknown): readonly AtSpiTarget[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return [];
    return [{ busName: entry[0], objectPath: entry[1] }];
  }) : [];
}

function findActionIndex(value: unknown, preferred: readonly string[]): number {
  if (!Array.isArray(value)) return -1;
  for (const name of preferred) {
    const index = value.findIndex((entry) => Array.isArray(entry) && String(entry[0]).toLocaleLowerCase() === name);
    if (index >= 0) return index;
  }
  return value.length > 0 ? 0 : -1;
}

function flatten(root: AtSpiNode): readonly AtSpiNode[] {
  return [root, ...root.children.flatMap(flatten)];
}

function unwrapRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

function variantString(value: unknown): string {
  const unwrapped = value instanceof Variant ? value.value : value;
  return typeof unwrapped === 'string' ? unwrapped : '';
}

function variantStringArray(value: unknown): readonly string[] {
  const unwrapped = value instanceof Variant ? value.value : value;
  return Array.isArray(unwrapped) ? unwrapped.filter((entry): entry is string => typeof entry === 'string') : [];
}

function boundedInteger(value: unknown, key: string, minimum: number, maximum: number, fallback: number): number {
  const candidate = record(value)[key];
  return typeof candidate === 'number' && Number.isInteger(candidate)
    ? Math.min(maximum, Math.max(minimum, candidate))
    : fallback;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function readString(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  return allowEmpty || value.trim().length > 0 ? value : undefined;
}

function atSpiUnavailable(message: string): Result<never> {
  return err(appError('CAPABILITY_UNAVAILABLE', message, true));
}

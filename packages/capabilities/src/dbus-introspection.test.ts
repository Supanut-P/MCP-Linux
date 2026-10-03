import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Resolve from dbus-next itself so this checks its actual pinned XML parser.
const require = createRequire(import.meta.url);
interface ProxyFixture {
  readonly nodes: string[];
  readonly _parser: { parseString(xml: string, callback: (error: Error | null, value: unknown) => void): void };
  _init(xml: string): Promise<unknown>;
}
const ProxyObject = require('dbus-next/lib/client/proxy-object.js') as new (bus: unknown, name: string, path: string) => ProxyFixture;

describe('pinned DBus introspection parser', () => {
  it('preserves real proxy child parsing without opening a bus connection', async () => {
    const call = vi.fn(async () => ({ body: [':1.23'] }));
    const proxy = new ProxyObject({ call, _nameOwners: {} }, 'org.example.Fixture', '/fixture');
    await expect(proxy._init('<node><node name="child"/><node name="../outside"/></node>')).resolves.toBe(proxy);
    expect(proxy.nodes).toEqual(['/fixture/child']);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not treat XML prototype keys as object prototypes', async () => {
    const proxy = new ProxyObject({}, 'org.example.Fixture', '/fixture');
    const parsed = await new Promise<unknown>((resolve, reject) => proxy._parser.parseString('<node><__proto__><polluted>XML_CANARY</polluted></__proto__></node>', (error, value) => error === null ? resolve(value) : reject(error)));
    expect(typeof parsed).toBe('object');
    const root = (parsed as { node: object }).node;
    expect(Object.hasOwn(root, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    expect('polluted' in root).toBe(false);
  });
});

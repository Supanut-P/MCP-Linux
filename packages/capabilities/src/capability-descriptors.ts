import type { CapabilityToolName } from './capability-tool-names.js';

export type CapabilityAvailability = 'always' | 'native' | 'optional';

export type CapabilityPermission = 'READ' | 'WRITE' | 'EXECUTE' | 'DANGEROUS';

export interface CapabilityDescriptor {
  readonly name: CapabilityToolName;
  readonly availability: CapabilityAvailability;
  readonly platforms: readonly NodeJS.Platform[];
  readonly requirements: readonly string[];
  readonly permission: CapabilityPermission;
  readonly supportsCancel: boolean;
  readonly supportsDryRun: boolean;
  readonly auditTarget: string;
}

const descriptor = (
  name: CapabilityToolName,
  availability: CapabilityAvailability,
  permission: CapabilityPermission,
  auditTarget: string,
  requirements: readonly string[] = [],
  supportsCancel = false,
  supportsDryRun = false,
  platforms: readonly NodeJS.Platform[] = ['linux'],
): CapabilityDescriptor => ({
  name,
  availability,
  platforms,
  requirements,
  permission,
  supportsCancel,
  supportsDryRun,
  auditTarget,
});

export const capabilityDescriptors: readonly CapabilityDescriptor[] = Object.freeze([
  descriptor('shell', 'always', 'EXECUTE', 'process', ['workspace registration'], true, true),
  descriptor('dom_cdp', 'optional', 'READ', 'browser', ['CDP-compatible browser']),
  descriptor('accessibility', 'native', 'READ', 'window', ['AT-SPI2']),
  descriptor('input_event', 'native', 'DANGEROUS', 'window', ['input permission or portal consent'], false, true),
  descriptor('vision', 'native', 'READ', 'display', ['XDG Screenshot portal and Tesseract'], false, true),
  descriptor('window', 'native', 'WRITE', 'window', ['compositor or X11 window access'], false, true),
  descriptor('health', 'always', 'READ', 'diagnostics'),
  descriptor('system_info', 'native', 'READ', 'system'),
  descriptor('journal', 'native', 'READ', 'system', ['journalctl'], true),
  descriptor('network', 'native', 'READ', 'network', ['iproute2 and iproute2 ss'], true),
  descriptor('service', 'native', 'DANGEROUS', 'system', ['systemd'], true, true),
  descriptor('package', 'native', 'DANGEROUS', 'package-manager', ['apt and dpkg'], true, true),
  descriptor('schedule', 'native', 'DANGEROUS', 'systemd-user', ['systemd user units'], true, true),
  descriptor('notification', 'native', 'WRITE', 'notification'),
  descriptor('file_dialog', 'native', 'WRITE', 'window'),
  descriptor('clipboard', 'native', 'WRITE', 'clipboard'),
  descriptor('web_fetch', 'optional', 'READ', 'network', ['network policy']),
]);

export function capabilityToolNamesForPlatform(platform: NodeJS.Platform): readonly CapabilityToolName[] {
  return capabilityDescriptors
    .filter((item) => item.platforms.includes(platform))
    .map((item) => item.name);
}

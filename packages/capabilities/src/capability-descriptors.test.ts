import { describe, expect, it } from 'vitest';

import { capabilityDescriptors } from './capability-descriptors.js';
import { capabilityToolNames, capabilityToolNamesForPlatform } from './index.js';

describe('capability descriptors', () => {
  it('describes every registered capability exactly once', () => {
    const descriptorNames = capabilityDescriptors.map((descriptor) => descriptor.name);

    expect(new Set(descriptorNames).size).toBe(descriptorNames.length);
    expect(new Set(descriptorNames)).toEqual(new Set(capabilityToolNames));
  });

  it('keeps Linux OCR dependencies truthful', () => {
    const descriptor = capabilityDescriptors.find((item) => item.name === 'vision');

    expect(descriptor).toMatchObject({
      supportsDryRun: true,
      auditTarget: 'display',
    });
    expect(descriptor?.requirements).toContain('XDG Screenshot portal and Tesseract');
  });

  it('advertises only the Linux headless capability surface', () => {
    const linux = capabilityToolNamesForPlatform('linux');

    expect(linux).toEqual([
      'shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window',
      'health', 'system_info', 'journal', 'network', 'service', 'package', 'schedule', 'notification', 'file_dialog', 'clipboard', 'web_fetch', 'container', 'archive', 'dependency_audit', 'remote_host', 'artifact_verify', 'http_probe', 'storage_usage', 'backup',
    ]);
  });
});

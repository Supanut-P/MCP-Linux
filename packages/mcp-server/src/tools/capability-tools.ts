import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import type { Result } from '@baitonghub-linux-mcp/domain';
import { DEFAULT_MCP_POLL_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS } from '@baitonghub-linux-mcp/shared';
import { SetOfMarksService } from '../set-of-marks-service.js';
import { withCapabilityOwnerMetadata } from '../request-scope.js';
import {
  accessibilityCapabilitySchema,
  clipboardCapabilitySchema,
  domCdpCapabilitySchema,
  fileDialogCapabilitySchema,
  healthCapabilitySchema,
  inputEventCapabilitySchema,
  notificationCapabilitySchema,
  shellCapabilitySchema,
  systemInfoCapabilitySchema,
  visionCapabilitySchema,
  visionAnnotatedCaptureSchema,
  uiTargetActionSchema,
  webFetchCapabilitySchema,
  windowCapabilitySchema,
} from './schemas.js';

function currentMcpPollWaitSeconds(context: McpToolContext): number {
  const configured = context.services.runtimeTiming?.().mcpPollWaitSeconds ?? DEFAULT_MCP_POLL_WAIT_SECONDS;
  if (!Number.isFinite(configured)) return DEFAULT_MCP_POLL_WAIT_SECONDS;
  return Math.max(MIN_CONFIGURABLE_WAIT_SECONDS, Math.min(MAX_CONFIGURABLE_WAIT_SECONDS, configured));
}

function normalizeNonBlockingCliInput(input: unknown, maxPollWaitSeconds: number): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const request = input as Record<string, unknown>;
  const operation = request.operation ?? 'run';
  if (operation === 'run') return { ...request, execution: 'background' };
  if (operation === 'wait') {
    const requestedWait = typeof request.timeout_seconds === 'number' ? request.timeout_seconds : maxPollWaitSeconds;
    return { ...request, timeout_seconds: Math.min(requestedWait, maxPollWaitSeconds) };
  }
  return input;
}

export function capabilityTools(context: McpToolContext): McpToolDefinition[] {
  const execute = (tool: Parameters<NonNullable<McpToolContext['services']['capabilities']>['execute']>[0], input: unknown, signal?: AbortSignal): Promise<Result<unknown>> => {
    if (context.services.capabilities === undefined) return Promise.resolve(missingService());
    const normalized = tool === 'shell'
      ? normalizeNonBlockingCliInput(input, currentMcpPollWaitSeconds(context))
      : input;
    const owned = tool === 'shell'
      ? withCapabilityOwnerMetadata(normalized, context.actor)
      : normalized;
    return context.services.capabilities.execute(tool, owned, signal);
  };
  const setOfMarks = new SetOfMarksService(context.services.capabilities);

  return [
    defineTool({
      name: 'shell',
      description: 'Non-blocking command runner for system operations and CLI tasks. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, so the call returns a task_id immediately instead of waiting for command completion. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). After one or two checks still show running, do not keep polling in the same chat turn: preserve task_id and return control so the durable task can continue without risking a ChatGPT turn timeout. Destructive shell commands still require explicit chat confirmation and userConfirmed: true unless that command family is globally auto-approved and this call supplies a registered workspaceId whose project boundary contains every target.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: shellCapabilitySchema,
      handler: async (input, signal) => execute('shell', input, signal),
    }),
    defineTool({
      name: 'dom_cdp',
      description: 'Default for web-page DOM work inside managed Chrome: inspect content, query selectors, click, type, navigate, evaluate JavaScript, wait, manage tabs, and capture screenshots. Use steps to batch related DOM actions in one call.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: domCdpCapabilitySchema,
      handler: async (input, signal) => execute('dom_cdp', input, signal),
    }),
    defineTool({
      name: 'accessibility',
      description: 'Semantic Linux UI inspection through AT-SPI2. Inspect accessible trees, focus controls, read or set values, and invoke supported actions when a desktop accessibility bus is available.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: accessibilityCapabilitySchema,
      handler: async (input, signal) => execute('accessibility', input, signal),
    }),
    defineTool({
      name: 'input_event',
      description: 'Low-level keyboard and pointer fallback. Use only when DOM/CDP and Accessibility cannot operate the target. Supports text, keys, mouse movement, clicks, drag, scroll, held buttons, release_all, and batched sequences.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: inputEventCapabilitySchema,
      handler: async (input, signal) => execute('input_event', input, signal),
    }),
    defineTool({
      name: 'vision',
      description: 'Visual and OCR fallback for content unavailable through DOM or Accessibility. Capture a display, window, or region, or run local Vision OCR. It never clicks or types.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: visionCapabilitySchema,
      handler: async (input, signal) => execute('vision', input, signal),
    }),
    defineTool({
      name: 'vision_annotated_capture',
      description: 'Capture a Linux display or region through the XDG portal and return a short-lived Set-of-Marks observation with numbered bounds, a content hash, and an annotated PNG.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: visionAnnotatedCaptureSchema,
      handler: async (input, signal) => setOfMarks.capture(input, signal),
    }),
    defineTool({
      name: 'ui_target_action',
      description: 'Act on one mark from a current vision_annotated_capture observation. The observation ID, optional hash, TTL, workspace owner, and current Accessibility element are checked before the action is sent.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: uiTargetActionSchema,
      handler: async (input, signal) => setOfMarks.act(input, signal),
    }),
    defineTool({
      name: 'window',
      description: 'Linux window inspection and control through the compositor or X11 fallback when the current display server permits it.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: windowCapabilitySchema,
      handler: async (input, signal) => execute('window', input, signal),
    }),
    defineTool({
      name: 'health',
      description: 'Diagnostics only. Check all baitonghub-linux-mcp backends or one public tool after a failure, when asked for status, or while diagnosing permissions. Do not use as a preflight before normal work.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: healthCapabilitySchema,
      handler: async (input, signal) => execute('health', input, signal),
    }),
    defineTool({
      name: 'system_info',
      description: 'Read-only system information: OS, CPU, memory, disks, battery, uptime, and top processes by memory. Use for environment checks and diagnostics.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: systemInfoCapabilitySchema,
      handler: async (input, signal) => execute('system_info', input, signal),
    }),
    defineTool({
      name: 'notification',
      description: 'Show a Linux desktop notification through org.freedesktop.Notifications when a desktop session is available.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: notificationCapabilitySchema,
      handler: async (input, signal) => execute('notification', input, signal),
    }),
    defineTool({
      name: 'file_dialog',
      description: 'Open the Linux XDG FileChooser portal and return the chosen path(s). The dialog does not read or write files itself.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: fileDialogCapabilitySchema,
      handler: async (input, signal) => execute('file_dialog', input, signal),
    }),
    defineTool({
      name: 'clipboard',
      description: 'Read or write the Linux clipboard through wl-clipboard, with xclip as the X11 fallback.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: clipboardCapabilitySchema,
      handler: async (input, signal) => execute('clipboard', input, signal),
    }),
    defineTool({
      name: 'web_fetch',
      description: 'Fetch an http/https URL (GET/POST/PUT/DELETE/HEAD) with bounded size and timeout. HTTP DELETE requires explicit chat confirmation and userConfirmed: true. Returns status, headers, and text or base64 body.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: webFetchCapabilitySchema,
      handler: async (input, signal) => execute('web_fetch', input, signal),
    }),
  ];
}

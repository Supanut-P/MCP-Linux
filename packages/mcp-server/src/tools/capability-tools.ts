import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { ok, type Result } from '@baitonghub-linux-mcp/domain';
import { DEFAULT_MCP_POLL_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS } from '@baitonghub-linux-mcp/shared';
import { SetOfMarksService } from '../set-of-marks-service.js';
import { withCapabilityOwnerMetadata } from '../request-scope.js';
import {
  accessibilityCapabilitySchema,
  clipboardCapabilitySchema,
  domCdpCapabilitySchema,
  fileDialogCapabilitySchema,
  healthCapabilitySchema,
  journalCapabilitySchema,
  serviceLogsCapabilitySchema,
  runtimeMetricsSchema,
  networkCapabilitySchema,
  packageCapabilitySchema,
  scheduleCapabilitySchema,
  serviceCapabilitySchema,
  inputEventCapabilitySchema,
  notificationCapabilitySchema,
  shellCapabilitySchema,
  systemInfoCapabilitySchema,
  visionCapabilitySchema,
  visionAnnotatedCaptureSchema,
  uiTargetActionSchema,
  webFetchCapabilitySchema,
  windowCapabilitySchema,
  containerCapabilitySchema,
  archiveCapabilitySchema,
  dependencyAuditCapabilitySchema,
  remoteHostCapabilitySchema,
  artifactVerifyCapabilitySchema,
  httpProbeCapabilitySchema,
  storageUsageCapabilitySchema,
  backupCapabilitySchema,
  remoteFleetCapabilitySchema,
  remoteRolloutCapabilitySchema,
  remoteRolloutResumeCapabilitySchema,
} from './schemas.js';
import { RemoteFleetRuntime } from '../remote-fleet-runtime.js';
import { RuntimeMetricsService } from '../runtime-metrics-service.js';

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
  const remoteFleet = new RemoteFleetRuntime(context.services.capabilities, context.services.remoteFleetAudit);
  const runtimeMetrics = new RuntimeMetricsService({
    ...(context.activity === undefined ? {} : { activity: context.activity }),
    ...(context.services.runtimeTaskSnapshot === undefined ? {} : { taskSnapshot: context.services.runtimeTaskSnapshot }),
  });

  return [
    defineTool({
      name: 'shell',
      description: 'Non-blocking command runner for system operations and CLI tasks. MCP run calls are ALWAYS forced to execution=background, even if a client requests foreground or auto, so the call returns a task_id immediately instead of waiting for command completion. Follow with status/logs/result; wait uses the user-configurable MCP poll window (5-60 seconds, default 5). After one or two checks still show running, do not keep polling in the same chat turn: preserve task_id and return control so the durable task can continue without risking a ChatGPT turn timeout. A reconnect-safe resume requires the task workspace, authenticated client, and one-time resume_token returned by run; resume rotates the token and changes only the transport session. Destructive shell commands still require explicit chat confirmation and userConfirmed: true unless that command family is globally auto-approved and this call supplies a registered workspaceId whose project boundary contains every target.',
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
      handler: async (input, signal) => {
        const result = input.operation === 'check_tool' && input.tool === 'runtime_metrics'
          ? ok({ tool: 'runtime_metrics', ...runtimeMetrics.health() })
          : await execute('health', input, signal);
        if (!result.ok || context.serverProfile === undefined) return result;
        return isRecord(result.value)
          ? ok({ ...result.value, serverProfile: context.serverProfile })
          : result;
      },
    }),
    defineTool({
      name: 'system_info',
      description: 'Read-only Linux system information: summary, CPU, memory, disks, uptime, bounded processes, and listening ports. Use for headless environment checks and diagnostics.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: systemInfoCapabilitySchema,
      handler: async (input, signal) => execute('system_info', input, signal),
    }),
    defineTool({
      name: 'runtime_metrics',
      description: 'Read-only bounded host, MCP runtime, and owned-task counters. It never returns hostname, command line, environment, paths, client identity, or secrets.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: runtimeMetricsSchema,
      handler: async (input, signal) => runtimeMetrics.execute(input, signal),
    }),
    defineTool({
      name: 'journal',
      description: 'Read bounded, sanitized systemd journal entries on Linux. Unit, priority, since, and line count are validated; provider stderr is never returned.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: journalCapabilitySchema,
      handler: async (input, signal) => execute('journal', input, signal),
    }),
    defineTool({
      name: 'service_logs',
      description: 'Read or continue a bounded, sanitized systemd service log stream on Linux. The unit and opaque cursor are validated; no arbitrary journal query or provider stderr is returned.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: serviceLogsCapabilitySchema,
      handler: async (input, signal) => execute('service_logs', input, signal),
    }),
    defineTool({
      name: 'network',
      description: 'Read-only Linux network observability for interfaces, routes, DNS resolution, listeners, and connectivity with bounded results.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: networkCapabilitySchema,
      handler: async (input, signal) => execute('network', input, signal),
    }),
    defineTool({
      name: 'service',
      description: 'Controlled Linux systemd administration. Inspect services with list, status, and is-enabled; state-changing operations require explicit confirmation and use fixed systemctl argv.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: serviceCapabilitySchema,
      handler: async (input, signal) => execute('service', input, signal),
    }),
    defineTool({
      name: 'package',
      description: 'Controlled Debian package inspection and administration through apt and dpkg. Mutations are simulated first, bounded to 50 packages, and require a matching plan hash plus explicit confirmation.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: packageCapabilitySchema,
      handler: async (input, signal) => execute('package', input, signal),
    }),
    defineTool({
      name: 'schedule',
      description: 'Create and manage user-only systemd timers under XDG_CONFIG_HOME/systemd/user. Plans are hashed before creation; executables must be the packaged CLI or inside a registered root.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: scheduleCapabilitySchema,
      handler: async (input, signal) => execute('schedule', input, signal),
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
    defineTool({
      name: 'container',
      description: 'Operate a registered project container stack through Docker or Podman using fixed argv. Compose files and bind-mount host paths must remain inside registered roots; mutations require explicit confirmation.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: containerCapabilitySchema,
      handler: async (input, signal) => execute('container', input, signal),
    }),
    defineTool({
      name: 'archive',
      description: 'List, plan, extract, or create bounded tar/tar.gz/zip archives inside registered roots. Unsafe archive members are rejected and extraction overwrites require confirmation.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: archiveCapabilitySchema,
      handler: async (input, signal) => execute('archive', input, signal),
    }),
    defineTool({
      name: 'dependency_audit',
      description: 'Run a read-only lockfile-selected dependency audit with fixed pnpm, npm, pip, or cargo commands and normalized findings. It never upgrades dependencies.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: dependencyAuditCapabilitySchema,
      handler: async (input, signal) => execute('dependency_audit', input, signal),
    }),
    defineTool({
      name: 'remote_host',
      description: 'Operate on explicitly registered SSH hosts with pinned fingerprints. Read operations are bounded and mutations require a matching preview hash plus explicit confirmation.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: remoteHostCapabilitySchema,
      handler: async (input, signal) => execute('remote_host', input, signal),
    }),
    defineTool({
      name: 'remote_fleet',
      description: 'Read-only inspection of 1-20 explicitly registered SSH hosts using health, inventory, service status, disk usage, checksum, or aggregate snapshot operations. At most four sessions run in parallel; host addresses, credentials, paths, and commands remain inside each host registration.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: remoteFleetCapabilitySchema,
      handler: async (input, signal) => remoteFleet.execute(input, signal),
    }),
    defineTool({
      name: 'remote_rollout',
      description: 'Plan, execute, inspect, or cancel a canary-first restart of one fixed systemd service across registered SSH hosts. Execution requires an unexpired preview hash and explicit confirmation; no arbitrary remote shell is accepted.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: remoteRolloutCapabilitySchema,
      handler: async (input, signal) => context.services.remoteRollout === undefined
        ? missingService()
        : context.services.remoteRollout.execute(input, signal),
    }),
    defineTool({
      name: 'remote_rollout_resume',
      description: 'Preview and execute a bounded recovery of a failed remote rollout. Successful hosts are never restarted; a fresh preview hash and explicit confirmation are required, and unverified remote outcomes are not retried.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: remoteRolloutResumeCapabilitySchema,
      handler: async (input, signal) => context.services.remoteRolloutResume === undefined
        ? missingService()
        : context.services.remoteRolloutResume.resume(input, signal),
    }),
    defineTool({
      name: 'artifact_verify',
      description: 'Verify a registered-workspace artifact with a bounded Node SHA-256 stream. It never invokes a shell command, follows escaping symlinks, or reads special files.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: artifactVerifyCapabilitySchema,
      handler: async (input, signal) => execute('artifact_verify', input, signal),
    }),
    defineTool({
      name: 'http_probe',
      description: 'Diagnose an HTTP(S) endpoint with bounded GET or HEAD, SSRF-safe DNS/redirect policy, a 30-second timeout, capped headers, and a capped response read.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: httpProbeCapabilitySchema,
      handler: async (input, signal) => execute('http_probe', input, signal),
    }),
    defineTool({
      name: 'storage_usage',
      description: 'Inspect filesystem capacity or bounded registered-workspace directory usage with fs.statfs. Device, FIFO, socket, and escaping symlink targets are rejected.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: storageUsageCapabilitySchema,
      handler: async (input, signal) => execute('storage_usage', input, signal),
    }),
    defineTool({
      name: 'backup',
      description: 'Create and verify self-contained manifest backups inside registered Linux roots. Plan/list/verify are read-only; create and restore require explicit user confirmation, and restore stages then atomically renames the destination.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: backupCapabilitySchema,
      handler: async (input, signal) => execute('backup', input, signal),
    }),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

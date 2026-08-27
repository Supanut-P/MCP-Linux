/* global AbortController, Buffer, clearTimeout, fetch, process, setTimeout */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputPath = path.join(repositoryRoot, 'docs', 'benchmarks', 'BASELINE.md');
const defaultRuns = 3;
const defaultRetries = 0;
const defaultTimeoutMs = 30_000;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runBenchmark(options);
  if (options.outputPath !== null) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, renderMarkdown(report), 'utf8');
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`);
}

function parseArgs(args) {
  const options = {
    runs: defaultRuns,
    retries: defaultRetries,
    timeoutMs: defaultTimeoutMs,
    outputPath: defaultOutputPath,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--runs') {
      options.runs = readPositiveInteger(args[++index], '--runs');
    } else if (arg === '--retries') {
      options.retries = readNonNegativeInteger(args[++index], '--retries');
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = readPositiveInteger(args[++index], '--timeout-ms');
    } else if (arg === '--output') {
      const value = args[++index];
      if (value === undefined || value.trim().length === 0) throw new Error('--output requires a path');
      options.outputPath = path.resolve(repositoryRoot, value);
    } else if (arg === '--no-output') {
      options.outputPath = null;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readPositiveInteger(value, flag) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function readNonNegativeInteger(value, flag) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function printUsage() {
  process.stdout.write([
    'Usage: pnpm benchmark:baseline [options]',
    '',
    'Options:',
    '  --runs <n>        Repetitions per scenario (default: 3)',
    '  --retries <n>     Transport retries per request (default: 0)',
    '  --timeout-ms <n>  Per-request timeout (default: 30000)',
    '  --output <path>   Markdown output path (default: docs/benchmarks/BASELINE.md)',
    '  --no-output       Print the report without writing a file',
    '  --json            Print machine-readable JSON instead of Markdown',
  ].join('\n') + '\n');
}

async function runBenchmark(options) {
  const fixture = await createFixture();
  let runtime;
  let server;
  try {
    const [{ createStdioMcpRuntime }, { startMcpHttp }, { SqliteDatabase, SqliteWorkspaceRepository }, { WorkspaceService }] = await Promise.all([
      import(pathToFileURL(path.join(repositoryRoot, 'apps', 'cli', 'dist', 'runtime', 'stdio-mcp-runtime.js')).href),
      import('@baitonghub-linux-mcp/mcp-server'),
      import('@baitonghub-linux-mcp/storage'),
      import('@baitonghub-linux-mcp/workspace'),
    ]);

    const database = new SqliteDatabase(path.join(fixture.dataPath, 'baitonghub-linux-mcp.sqlite'));
    const workspaceRepository = new SqliteWorkspaceRepository(database);
    const workspaceService = new WorkspaceService(workspaceRepository);
    const added = await workspaceService.add('baseline-fixture', fixture.workspacePath);
    database.close();
    if (!added.ok) throw new Error(`Could not register benchmark fixture: ${added.error.message}`);

    runtime = createStdioMcpRuntime(fixture.dataPath, added.value, true);
    server = await startMcpHttp({
      port: 0,
      services: runtime.services,
      actor: runtime.actor,
      activityTracker: runtime.activityTracker,
    });

    const client = new McpHttpClient(server.endpoint, options.timeoutMs, options.retries);
    const discovery = await client.discover();
    const scenarios = buildScenarios(added.value.id);
    const scenarioReports = [];
    for (const scenario of scenarios) {
      scenarioReports.push(await runScenario(client, scenario, options.runs));
    }

    return {
      generatedAt: new Date().toISOString(),
      repository: {
        branch: await readGitValue(['branch', '--show-current']),
        commit: await readGitValue(['rev-parse', 'HEAD']),
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        transport: 'loopback Streamable HTTP (legacy-compatible claim-less MCP route)',
        bind: '127.0.0.1 (ephemeral port)',
        fixture: 'temporary synthetic repository; deleted after the run',
      },
      configuration: {
        runs: options.runs,
        retriesConfigured: options.retries,
        timeoutMs: options.timeoutMs,
      },
      discovery: {
        protocolVersion: discovery.protocolVersion,
        toolCount: discovery.tools.length,
        tools: discovery.tools,
        initializeLatencyMs: discovery.initializeLatencyMs,
        toolsListLatencyMs: discovery.toolsListLatencyMs,
        handshakeBytesTransferred: discovery.handshakeBytesTransferred,
        protocolRequests: discovery.protocolRequests,
      },
      scenarios: scenarioReports,
      totals: summarizeTotals(scenarioReports, discovery, client),
    };
  } finally {
    await server?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
}

async function createFixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'baitonghub-linux-mcp-baseline-'));
  const workspacePath = path.join(rootPath, 'workspace');
  const dataPath = path.join(rootPath, 'data');
  const files = {
    'package.json': JSON.stringify({
      name: 'baitonghub-linux-mcp-baseline-fixture',
      private: true,
      scripts: { test: 'node -e "process.exit(1)"' },
    }, null, 2) + '\n',
    'README.md': '# Baseline fixture\n\nThis repository contains a small login flow for deterministic MCP benchmarks.\n',
    'src/auth/login.ts': [
      'export interface LoginRequest {',
      '  readonly username: string;',
      '  readonly password: string;',
      '}',
      '',
      'export function login(request: LoginRequest): boolean {',
      '  return request.username.length > 0 && request.password.length > 0;',
      '}',
      '',
    ].join('\n'),
    'src/auth/session.ts': [
      'export interface Session {',
      '  readonly userId: string;',
      '  readonly expiresAt: number;',
      '}',
      '',
      'export function createSession(userId: string): Session {',
      '  return { userId, expiresAt: Date.now() + 3_600_000 };',
      '}',
      '',
    ].join('\n'),
    'src/ui/LoginForm.tsx': [
      "import { login } from '../auth/login';",
      '',
      'export function LoginForm() {',
      '  return <button onClick={() => login({ username: \'demo\', password: \'demo\' })}>Login</button>;',
      '}',
      '',
    ].join('\n'),
    'tests/auth.test.ts': [
      "import { login } from '../src/auth/login';",
      '',
      "test('accepts a complete login request', () => {",
      "  if (!login({ username: 'demo', password: 'secret' })) throw new Error('login failed');",
      '});',
      '',
    ].join('\n'),
    'tests/ui.test.ts': [
      "test('login button is visible', () => {",
      "  const label = 'Login';",
      "  if (label.length === 0) throw new Error('missing label');",
      '});',
      '',
    ].join('\n'),
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(workspacePath, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  await mkdir(dataPath, { recursive: true });
  await runGit(workspacePath, ['init', '--initial-branch=main']);
  await runGit(workspacePath, ['config', 'user.email', 'baitonghub-linux-mcp-baseline@localhost']);
  await runGit(workspacePath, ['config', 'user.name', 'baitonghub-linux-mcp baseline']);
  await runGit(workspacePath, ['add', '.']);
  await runGit(workspacePath, ['commit', '-m', 'baseline fixture']);
  await writeFile(
    path.join(workspacePath, 'src', 'auth', 'login.ts'),
    `${files['src/auth/login.ts']}export const loginAuditLabel = 'login';\n`,
    'utf8',
  );

  return { rootPath, workspacePath, dataPath };
}

async function runGit(cwd, args) {
  await execFileAsync('git', args, { cwd, maxBuffer: 1_000_000 });
}

async function readGitValue(args) {
  try {
    const result = await execFileAsync('git', args, { cwd: repositoryRoot, maxBuffer: 100_000 });
    return result.stdout.trim();
  } catch {
    return 'unknown';
  }
}

function buildScenarios(workspaceId) {
  const common = { workspaceId };
  return [
    {
      name: 'simple-file-read',
      purpose: 'Read one known source file.',
      steps: [{ tool: 'read_file', arguments: { ...common, path: 'src/auth/login.ts' } }],
    },
    {
      name: 'workspace-search',
      purpose: 'Find login-related source matches with ripgrep.',
      steps: [{ tool: 'search_text', arguments: { ...common, query: 'login', path: 'src', glob: '*.{ts,tsx}', maxResults: 50 } }],
    },
    {
      name: 'git-status-diff',
      purpose: 'Inspect current Git state and the working-tree patch.',
      steps: [
        { tool: 'git_status', arguments: common },
        { tool: 'git_diff', arguments: { ...common, maxBytes: 1_000_000 } },
      ],
    },
    {
      name: 'bug-investigation',
      purpose: 'Search, inspect the suspected file, and correlate the change with Git state and tests.',
      steps: [
        { tool: 'search_text', arguments: { ...common, query: 'login', maxResults: 50 } },
        { tool: 'read_file', arguments: { ...common, path: 'src/auth/login.ts' } },
        { tool: 'git_status', arguments: common },
        { tool: 'git_diff', arguments: { ...common, maxBytes: 1_000_000 } },
        { tool: 'search_files', arguments: { ...common, glob: '*.test.ts', maxResults: 50 } },
      ],
    },
    {
      name: 'code-review',
      purpose: 'Review changed code, recent history, and related symbols.',
      steps: [
        { tool: 'git_status', arguments: common },
        { tool: 'git_diff', arguments: { ...common, maxBytes: 1_000_000 } },
        { tool: 'git_log', arguments: { ...common, maxCommits: 5, maxBytes: 100_000 } },
        { tool: 'search_text', arguments: { ...common, query: 'export', glob: '*.{ts,tsx}', maxResults: 50 } },
      ],
    },
    {
      name: 'ui-debugging',
      purpose: 'Check managed browser/UI capability readiness without mutating the desktop.',
      steps: [
        { tool: 'health', arguments: { operation: 'check_all' } },
        { tool: 'dom_cdp', arguments: { action: 'status' } },
      ],
    },
    {
      name: 'test-failure-investigation',
      purpose: 'Inspect test configuration, test matches, the failing test surface, and the current patch.',
      steps: [
        { tool: 'read_file', arguments: { ...common, path: 'package.json' } },
        { tool: 'search_text', arguments: { ...common, query: 'test', glob: '*.{json,ts,tsx}', maxResults: 50 } },
        { tool: 'read_file', arguments: { ...common, path: 'tests/auth.test.ts' } },
        { tool: 'git_diff', arguments: { ...common, maxBytes: 1_000_000 } },
      ],
    },
  ];
}

async function runScenario(client, scenario, runs) {
  const samples = [];
  for (let run = 1; run <= runs; run += 1) {
    const started = performance.now();
    const calls = [];
    for (const step of scenario.steps) {
      const call = await client.callTool(step.tool, step.arguments);
      calls.push(call);
    }
    samples.push({
      run,
      workflowLatencyMs: round(performance.now() - started),
      toolCalls: calls.length,
      errors: calls.filter((call) => call.error).length,
      retries: calls.reduce((total, call) => total + call.retries, 0),
      bytesTransferred: calls.reduce((total, call) => total + call.requestBytes + call.responseBytes, 0),
      resultBytes: calls.reduce((total, call) => total + call.responseBytes, 0),
      toolLatencyMs: calls.map((call) => call.latencyMs),
    });
  }

  const latencies = samples.flatMap((sample) => sample.toolLatencyMs);
  const workflowLatencies = samples.map((sample) => sample.workflowLatencyMs);
  return {
    name: scenario.name,
    purpose: scenario.purpose,
    runs,
    callsPerRun: scenario.steps.length,
    totalToolCalls: samples.reduce((total, sample) => total + sample.toolCalls, 0),
    averageWorkflowLatencyMs: round(average(workflowLatencies)),
    p50WorkflowLatencyMs: round(percentile(workflowLatencies, 0.5)),
    p95WorkflowLatencyMs: round(percentile(workflowLatencies, 0.95)),
    averageToolLatencyMs: round(average(latencies)),
    p50ToolLatencyMs: round(percentile(latencies, 0.5)),
    p95ToolLatencyMs: round(percentile(latencies, 0.95)),
    bytesTransferred: samples.reduce((total, sample) => total + sample.bytesTransferred, 0),
    resultBytes: samples.reduce((total, sample) => total + sample.resultBytes, 0),
    errors: samples.reduce((total, sample) => total + sample.errors, 0),
    retries: samples.reduce((total, sample) => total + sample.retries, 0),
    samples,
  };
}

function summarizeTotals(scenarios, discovery, client) {
  const allToolLatencies = scenarios.flatMap((scenario) => scenario.samples.flatMap((sample) => sample.toolLatencyMs));
  const allWorkflowLatencies = scenarios.flatMap((scenario) => scenario.samples.map((sample) => sample.workflowLatencyMs));
  return {
    totalToolCalls: scenarios.reduce((total, scenario) => total + scenario.totalToolCalls, 0),
    totalProtocolRequests: client.protocolRequests,
    averageToolLatencyMs: round(average(allToolLatencies)),
    p50ToolLatencyMs: round(percentile(allToolLatencies, 0.5)),
    p95ToolLatencyMs: round(percentile(allToolLatencies, 0.95)),
    averageWorkflowLatencyMs: round(average(allWorkflowLatencies)),
    p50WorkflowLatencyMs: round(percentile(allWorkflowLatencies, 0.5)),
    p95WorkflowLatencyMs: round(percentile(allWorkflowLatencies, 0.95)),
    bytesTransferred: scenarios.reduce((total, scenario) => total + scenario.bytesTransferred, 0) + discovery.handshakeBytesTransferred,
    resultBytes: scenarios.reduce((total, scenario) => total + scenario.resultBytes, 0),
    errors: scenarios.reduce((total, scenario) => total + scenario.errors, 0),
    retries: scenarios.reduce((total, scenario) => total + scenario.retries, 0),
  };
}

class McpHttpClient {
  constructor(endpoint, timeoutMs, maxRetries) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.nextId = 1;
    this.sessionId = null;
    this.protocolRequests = 0;
  }

  async discover() {
    const initialize = await this.request('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'baitonghub-linux-mcp-baseline-benchmark', version: '1.0.0' },
    });
    await this.request('notifications/initialized', undefined, false);
    const toolsList = await this.request('tools/list', {});
    const tools = Array.isArray(toolsList.result?.tools)
      ? toolsList.result.tools.map((tool) => ({
        name: typeof tool.name === 'string' ? tool.name : 'unknown',
        description: typeof tool.description === 'string' ? tool.description : '',
        inputProperties: countInputProperties(tool.inputSchema),
      }))
      : [];
    return {
      protocolVersion: readProtocolVersion(initialize.result),
      tools,
      initializeLatencyMs: initialize.latencyMs,
      toolsListLatencyMs: toolsList.latencyMs,
      handshakeBytesTransferred: initialize.requestBytes + initialize.responseBytes
        + toolsList.requestBytes + toolsList.responseBytes,
      protocolRequests: 3,
    };
  }

  async callTool(name, args) {
    try {
      const response = await this.request('tools/call', { name, arguments: args });
      return {
        latencyMs: response.latencyMs,
        requestBytes: response.requestBytes,
        responseBytes: response.responseBytes,
        retries: response.retries,
        error: response.result?.isError === true,
      };
    } catch (error) {
      return {
        latencyMs: 0,
        requestBytes: 0,
        responseBytes: 0,
        retries: error.retries ?? 0,
        error: true,
      };
    }
  }

  async request(method, params, expectsResponse = true) {
    const id = expectsResponse ? this.nextId++ : undefined;
    const payload = { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) };
    const body = JSON.stringify(payload);
    const requestBytes = Buffer.byteLength(body, 'utf8');
    let retries = 0;
    while (true) {
      this.protocolRequests += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const started = performance.now();
      try {
        const headers = {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(this.sessionId === null ? {} : { 'mcp-session-id': this.sessionId }),
        };
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        const raw = Buffer.from(await response.arrayBuffer());
        const sessionId = response.headers.get('mcp-session-id');
        if (sessionId !== null && sessionId.length > 0) this.sessionId = sessionId;
        if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${raw.toString('utf8').slice(0, 200)}`);
        const envelope = parseResponseBody(raw.toString('utf8'));
        if (expectsResponse && envelope === undefined) throw new Error('MCP response did not contain JSON');
        if (envelope?.error !== undefined) throw new Error(`MCP JSON-RPC error: ${JSON.stringify(envelope.error)}`);
        return {
          result: envelope?.result,
          latencyMs: round(performance.now() - started),
          requestBytes,
          responseBytes: raw.byteLength,
          retries,
        };
      } catch (error) {
        if (retries >= this.maxRetries) {
          if (error instanceof Error) error.retries = retries;
          throw error;
        }
        retries += 1;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

function parseResponseBody(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const dataLines = raw.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(dataLines[index]);
      } catch {
        // Continue until the last valid SSE data frame.
      }
    }
  }
  return undefined;
}

function readProtocolVersion(result) {
  return typeof result?.protocolVersion === 'string' ? result.protocolVersion : 'unknown';
}

function countInputProperties(schema) {
  return typeof schema?.properties === 'object' && schema.properties !== null
    ? Object.keys(schema.properties).length
    : 0;
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function renderMarkdown(report) {
  const scenarioRows = report.scenarios.map((scenario) => [
    scenario.name,
    scenario.runs,
    scenario.callsPerRun,
    scenario.totalToolCalls,
    formatNumber(scenario.averageWorkflowLatencyMs),
    formatNumber(scenario.averageToolLatencyMs),
    formatNumber(scenario.p50ToolLatencyMs),
    formatNumber(scenario.p95ToolLatencyMs),
    formatNumber(scenario.bytesTransferred),
    formatNumber(scenario.resultBytes),
    scenario.errors,
    scenario.retries,
  ]);
  const toolList = report.discovery.tools.map((tool) => `- \`${tool.name}\` (${tool.inputProperties} input properties)`).join('\n');
  const totals = report.totals;
  return [
    '# baitonghub-linux-mcp Baseline Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    `Repository: \`${report.repository.branch}\` @ \`${report.repository.commit}\``,
    '',
    '## Scope',
    '',
    'This is the Phase 00 synthetic baseline. It starts the built baitonghub-linux-mcp application runtime, registers a temporary fixture workspace, measures the loopback MCP HTTP transport, and deletes the fixture afterward. It is a repeatable local contract baseline, not a production-machine benchmark.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Node | \`${report.environment.node}\` |`,
    `| Platform | \`${report.environment.platform}/${report.environment.arch}\` |`,
    `| Transport | ${report.environment.transport} at \`${report.environment.bind}\` |`,
    `| Runs per scenario | ${report.configuration.runs} |`,
    `| Configured retries | ${report.configuration.retriesConfigured} |`,
    `| Request timeout | ${report.configuration.timeoutMs} ms |`,
    `| Fixture | ${report.environment.fixture} |`,
    '',
    '## MCP discovery baseline',
    '',
    `- Negotiated protocol: \`${report.discovery.protocolVersion}\``,
    `- Tool count: **${report.discovery.toolCount}**`,
    `- Initialize latency: ${formatNumber(report.discovery.initializeLatencyMs)} ms`,
    `- tools/list latency: ${formatNumber(report.discovery.toolsListLatencyMs)} ms`,
    `- Handshake body bytes transferred: ${formatNumber(report.discovery.handshakeBytesTransferred)}`,
    `- Handshake protocol requests: ${report.discovery.protocolRequests} (initialize, initialized notification, tools/list)`,
    '',
    '### Discovered tools',
    '',
    toolList,
    '',
    '## Scenario measurements',
    '',
    '| Scenario | Runs | Calls/run | Tool calls | Avg workflow ms | Avg tool ms | p50 tool ms | p95 tool ms | Bytes transferred | Result bytes | Errors | Retries |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...scenarioRows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## Totals',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Tool calls | ${totals.totalToolCalls} |`,
    `| Protocol requests | ${totals.totalProtocolRequests} |`,
    `| Average tool latency | ${formatNumber(totals.averageToolLatencyMs)} ms |`,
    `| p50 tool latency | ${formatNumber(totals.p50ToolLatencyMs)} ms |`,
    `| p95 tool latency | ${formatNumber(totals.p95ToolLatencyMs)} ms |`,
    `| Average workflow latency | ${formatNumber(totals.averageWorkflowLatencyMs)} ms |`,
    `| p50 workflow latency | ${formatNumber(totals.p50WorkflowLatencyMs)} ms |`,
    `| p95 workflow latency | ${formatNumber(totals.p95WorkflowLatencyMs)} ms |`,
    `| Bytes transferred | ${formatNumber(totals.bytesTransferred)} |`,
    `| Result bytes | ${formatNumber(totals.resultBytes)} |`,
    `| Errors | ${totals.errors} |`,
    `| Retries | ${totals.retries} |`,
    '',
    '## Measurement contract',
    '',
    '- **Tool calls** count `tools/call` requests only. The handshake and discovery requests are reported separately and included in **protocol requests**.',
    '- **Latency** is measured around each HTTP request from the benchmark process. Workflow latency covers all sequential tool calls in one scenario run.',
    '- **Bytes transferred** is the UTF-8 request body plus the raw HTTP response body for every measured request, including the discovery handshake in the total.',
    '- **Result bytes** is the raw response body for tool calls; it includes the JSON-RPC envelope and MCP result metadata.',
    '- **Errors** count transport/JSON-RPC failures and MCP tool results with `isError: true`. A failed step does not discard sibling steps in the scenario.',
    '- **Retries** count only automatic transport retries. The default baseline uses zero retries so failures remain visible.',
    '',
    '## Baseline interpretation',
    '',
    'This report records the current sequential call cost before Phase 01. Future parallel execution, context aggregation, pagination, indexing, and caching changes must preserve the primitive-tool contract and must be compared against this report without silently reducing accessible context.',
    '',
  ].join('\n');
}

main().catch((error) => {
  process.stderr.write(`Baseline benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

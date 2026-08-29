import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityBackend } from './local-capability-service.js';

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const DEFAULT_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_HTTP_BYTES = 64 * 1024;
const MAX_HTTP_REDIRECTS = 5;
const MAX_HTTP_HEADERS = 64;
const MAX_HTTP_HEADER_VALUE = 4096;
const MAX_HTTP_HEADER_BYTES = 16 * 1024;
const MAX_STORAGE_ENTRIES = 500;

export type OperatorProbeOperation = 'artifact_verify' | 'http_probe' | 'storage_usage';

export interface OperatorProbeOptions {
  readonly allowedRootsProvider?: () => Promise<readonly string[]> | readonly string[];
  readonly workspaceRootProvider?: (workspaceId: string) => Promise<string | null> | string | null;
  readonly fetchImpl?: typeof fetch;
  readonly lookupImpl?: (hostname: string) => Promise<readonly string[]>;
  readonly artifactMaxBytes?: number;
}

/** Bounded, read-only probes. The operation is fixed per instance so MCP input
 * cannot switch a tool into another capability. */
export class OperatorProbeBackend implements CapabilityBackend {
  private readonly operation: OperatorProbeOperation;
  private readonly roots: () => Promise<readonly string[]> | readonly string[];
  private readonly workspaceRoot: ((workspaceId: string) => Promise<string | null> | string | null) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupImpl: (hostname: string) => Promise<readonly string[]>;
  private readonly artifactMaxBytes: number;

  public constructor(operation: OperatorProbeOperation, options: OperatorProbeOptions = {}) {
    this.operation = operation;
    this.roots = options.allowedRootsProvider ?? ((): readonly string[] => []);
    this.workspaceRoot = options.workspaceRootProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookupImpl = options.lookupImpl ?? (async (hostname: string): Promise<readonly string[]> => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
    this.artifactMaxBytes = clampInteger(options.artifactMaxBytes ?? DEFAULT_ARTIFACT_BYTES, 1, MAX_ARTIFACT_BYTES);
  }

  public async health(): Promise<Record<string, unknown>> {
    const workspaceReady = this.operation === 'http_probe' || this.workspaceRoot !== undefined;
    return {
      provider: this.operation === 'http_probe' ? 'node fetch + dns policy' : 'node fs + crypto',
      available: true,
      ready: workspaceReady,
      ...(workspaceReady ? {} : { reason: 'Workspace root resolver is not configured' }),
    };
  }

  public execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted === true) return Promise.resolve(cancelled());
    if (this.operation === 'artifact_verify') return this.verifyArtifact(input, signal);
    if (this.operation === 'http_probe') return this.probeHttp(input, signal);
    return this.inspectStorage(input, signal);
  }

  private async verifyArtifact(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const request = parseArtifactRequest(input);
    if (!request.ok) return request;
    const resolved = await this.resolveWorkspacePath(request.value.workspaceId, request.value.path, 'file');
    if (!resolved.ok) return resolved;
    if (signal?.aborted === true) return cancelled();
    let metadata;
    try { metadata = await stat(resolved.value.path); } catch { return unavailable('Artifact could not be read'); }
    if (!metadata.isFile()) return invalid('Artifact must be a regular file');
    if (metadata.size > this.artifactMaxBytes) return invalid('Artifact exceeds the configured size limit');

    const digest = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(resolved.value.path, { start: 0, end: Math.max(0, this.artifactMaxBytes - 1), highWaterMark: 64 * 1024 })) {
        if (signal !== undefined && signal.aborted) return cancelled();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > this.artifactMaxBytes) return invalid('Artifact exceeds the configured size limit');
        digest.update(buffer);
      }
    } catch { return unavailable('Artifact could not be read'); }
    const value = digest.digest('hex');
    return ok({ algorithm: 'sha256', digest: value, matches: request.value.expectedSha256 === undefined ? null : value === request.value.expectedSha256, bytes });
  }

  private async probeHttp(input: unknown, parentSignal?: AbortSignal): Promise<Result<unknown>> {
    const request = parseHttpRequest(input);
    if (!request.ok) return request;
    if (parentSignal?.aborted === true) return cancelled();
    const timeoutSignal = AbortSignal.timeout(request.value.timeoutSeconds * 1000);
    const signal = parentSignal === undefined ? timeoutSignal : AbortSignal.any([parentSignal, timeoutSignal]);
    let current: URL;
    try { current = new URL(request.value.url); } catch { return invalid('URL is invalid'); }
    const initialPolicy = await this.validateNetworkTarget(current, signal);
    if (!initialPolicy.ok) return initialPolicy;

    const redirectChain: string[] = [];
    const started = Date.now();
    let response: Response | undefined;
    for (let redirect = 0; redirect <= MAX_HTTP_REDIRECTS; redirect += 1) {
      if (signal.aborted) return cancelled();
      redirectChain.push(current.toString());
      try {
        response = await this.fetchImpl(current.toString(), { method: request.value.method, redirect: 'manual', signal });
      } catch (error: unknown) {
        if (signal.aborted) return cancelled();
        return err(appError('CAPABILITY_UNAVAILABLE', error instanceof Error && error.message.length > 0 ? 'HTTP probe request failed' : 'HTTP probe provider failed', true));
      }
      if (!isRedirect(response.status)) break;
      const location = response.headers.get('location');
      if (location === null || location.trim().length === 0) break;
      if (redirect === MAX_HTTP_REDIRECTS) return invalid('HTTP redirect limit exceeded');
      try { current = new URL(location, current); } catch { return invalid('HTTP redirect location is invalid'); }
      const policy = await this.validateNetworkTarget(current, signal);
      if (!policy.ok) return policy;
    }
    if (response === undefined) return unavailable('HTTP probe did not return a response');

    let bodyBytes = 0;
    let bodyTruncated = false;
    if (request.value.method === 'GET' && response.body !== null) {
      try {
        const reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bodyBytes += chunk.value.byteLength;
          if (bodyBytes > request.value.maxBytes) {
            bodyTruncated = true;
            await reader.cancel().catch(() => undefined);
            bodyBytes = request.value.maxBytes;
            break;
          }
        }
      } catch {
        if (signal.aborted) return cancelled();
        return unavailable('HTTP response could not be read');
      }
    }
    const headers = boundedHeaders(response.headers);
    return ok({
      status: response.status,
      headers: headers.value,
      headers_truncated: headers.truncated,
      latency_ms: Math.max(0, Date.now() - started),
      redirect_chain: redirectChain,
      ...(request.value.method === 'GET' ? { body_bytes: bodyBytes, body_truncated: bodyTruncated } : {}),
    });
  }

  private async inspectStorage(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    const request = parseStorageRequest(input);
    if (!request.ok) return request;
    const resolved = await this.resolveWorkspacePath(request.value.workspaceId, request.value.path, 'any');
    if (!resolved.ok) return resolved;
    if (signal?.aborted === true) return cancelled();
    let metadata;
    try { metadata = await lstat(resolved.value.path); } catch { return unavailable('Storage path could not be read'); }
    const checked = await this.checkNode(resolved.value.path, resolved.value.root, metadata);
    if (!checked.ok) return checked;
    if (request.value.operation === 'filesystem') {
      try {
        const usage = await statfs(resolved.value.path);
        const blockSize = Number(usage.bsize);
        const total = blockSize * Number(usage.blocks);
        const free = blockSize * Number(usage.bfree);
        const available = blockSize * Number(usage.bavail);
        return ok({ operation: 'filesystem', path: relativePath(resolved.value.root, resolved.value.path), bytes: { total, free, available, used: Math.max(0, total - free) }, truncated: false });
      } catch { return unavailable('Filesystem statistics are unavailable'); }
    }
    if (metadata.isDirectory() === false) return invalid('Directory storage operations require a directory');
    if (request.value.operation === 'directory') return this.listDirectory(resolved.value.path, resolved.value.root, signal);
    return this.listLargestFiles(resolved.value.path, resolved.value.root, signal);
  }

  private async listDirectory(directory: string, root: string, signal?: AbortSignal): Promise<Result<unknown>> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return unavailable('Directory could not be read'); }
    const output: Array<Record<string, unknown>> = [];
    let bytes = 0;
    const truncated = entries.length > MAX_STORAGE_ENTRIES;
    for (const entry of entries.slice(0, MAX_STORAGE_ENTRIES)) {
      if (signal?.aborted === true) return cancelled();
      const candidate = path.join(directory, entry.name);
      let metadata;
      try { metadata = await lstat(candidate); } catch { return unavailable('Directory entry could not be read'); }
      const checked = await this.checkNode(candidate, root, metadata);
      if (!checked.ok) return checked;
      const isSymlink = metadata.isSymbolicLink();
      const entryBytes = isSymlink || metadata.isDirectory() ? 0 : metadata.size;
      bytes += entryBytes;
      output.push({ name: entry.name, path: relativePath(root, candidate), type: isSymlink ? 'symlink' : metadata.isDirectory() ? 'directory' : 'file', bytes: entryBytes });
    }
    return ok({ operation: 'directory', path: relativePath(root, directory), entries: output, bytes, truncated });
  }

  private async listLargestFiles(directory: string, root: string, signal?: AbortSignal): Promise<Result<unknown>> {
    const queue = [directory];
    const files: Array<{ path: string; bytes: number }> = [];
    let visited = 0;
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift()!;
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); } catch { return unavailable('Directory could not be read'); }
      for (const entry of entries) {
        if (signal?.aborted === true) return cancelled();
        visited += 1;
        if (visited > MAX_STORAGE_ENTRIES) { truncated = true; break; }
        const candidate = path.join(current, entry.name);
        let metadata;
        try { metadata = await lstat(candidate); } catch { return unavailable('Directory entry could not be read'); }
        const checked = await this.checkNode(candidate, root, metadata);
        if (!checked.ok) return checked;
        if (metadata.isDirectory()) queue.push(candidate);
        else if (metadata.isFile()) files.push({ path: relativePath(root, candidate), bytes: metadata.size });
      }
      if (truncated) break;
    }
    files.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
    const output = files.slice(0, MAX_STORAGE_ENTRIES);
    if (files.length > MAX_STORAGE_ENTRIES) truncated = true;
    return ok({ operation: 'largest_files', path: relativePath(root, directory), files: output, bytes: output.reduce((sum, file) => sum + file.bytes, 0), truncated });
  }

  private async checkNode(candidate: string, root: string, metadata: { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }): Promise<Result<void>> {
    if (metadata.isSymbolicLink()) {
      let target;
      try { target = await realpath(candidate); } catch { return invalid('Symlink target could not be resolved'); }
      if (!isWithin(root, target)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Symlink target is outside the registered workspace'));
      return ok(undefined);
    }
    if (!metadata.isFile() && !metadata.isDirectory()) return invalid('Special files are not supported by storage probes');
    return ok(undefined);
  }

  private async resolveWorkspacePath(workspaceId: string, requestedPath: string, expected: 'file' | 'any'): Promise<Result<{ root: string; path: string }>> {
    if (this.workspaceRoot === undefined) return unavailable('Workspace root resolver is not configured');
    let configuredRoot: string | null;
    try { configuredRoot = await this.workspaceRoot(workspaceId); } catch { return unavailable('Workspace root is unavailable'); }
    if (configuredRoot === null || configuredRoot.trim().length === 0) return invalid('Workspace is not registered');
    let roots: readonly string[];
    try { roots = await this.roots(); } catch { return unavailable('Registered roots are unavailable'); }
    let root: string;
    try { root = await realpath(configuredRoot); } catch { return unavailable('Registered workspace root could not be resolved'); }
    try { if (!(await stat(root)).isDirectory()) return invalid('Registered workspace root must be a directory'); } catch { return unavailable('Registered workspace root could not be inspected'); }
    const allowed = await Promise.all(roots.map(async (candidate) => { try { return await realpath(candidate); } catch { return null; } }));
    if (!allowed.some((candidate) => candidate !== null && isWithin(candidate, root))) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Workspace is outside registered roots'));
    const candidate = path.resolve(root, requestedPath);
    if (!isWithin(root, candidate)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path is outside the registered workspace'));
    let canonical: string;
    try { canonical = await realpath(candidate); } catch { return invalid('Path does not exist'); }
    if (!isWithin(root, canonical)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Path resolves outside the registered workspace'));
    if (expected === 'file') {
      try { if (!(await stat(canonical)).isFile()) return invalid('Path must be a regular file'); } catch { return unavailable('Path could not be inspected'); }
    }
    return ok({ root, path: canonical });
  }

  private async validateNetworkTarget(url: URL, signal: AbortSignal): Promise<Result<void>> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalid('Only http and https URLs are supported');
    if (url.username.length > 0 || url.password.length > 0) return invalid('URL credentials are not allowed');
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isBlockedHostname(hostname)) return invalid('Network destination is not allowed');
    if (isIP(hostname) !== 0) return isPrivateAddress(hostname) ? invalid('Network destination is not allowed') : ok(undefined);
    try {
      const addresses = await lookupWithTimeout(this.lookupImpl, hostname, 5_000);
      if (signal.aborted) return cancelled();
      if (addresses.length === 0 || addresses.some(isPrivateAddress)) return invalid('Network destination is not allowed');
      return ok(undefined);
    } catch { return unavailable('Network destination could not be resolved'); }
  }
}

async function lookupWithTimeout(lookup: (hostname: string) => Promise<readonly string[]>, hostname: string, timeoutMs: number): Promise<readonly string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname),
      new Promise<readonly string[]>((_, reject) => { timer = setTimeout(() => reject(new Error('dns timeout')), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseArtifactRequest(value: unknown): Result<{ workspaceId: string; path: string; expectedSha256?: string }> {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || typeof value.path !== 'string') return invalid('artifact_verify requires workspaceId and path');
  if (value.path.includes('\0') || value.path.length === 0 || value.path.length > 4096) return invalid('Path is invalid');
  const expected = value.expected_sha256;
  if (expected !== undefined && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected))) return invalid('expected_sha256 is invalid');
  return ok({ workspaceId: value.workspaceId, path: value.path, ...(expected === undefined ? {} : { expectedSha256: expected.toLowerCase() }) });
}

function parseHttpRequest(value: unknown): Result<{ url: string; method: 'GET' | 'HEAD'; timeoutSeconds: number; maxBytes: number }> {
  if (!isRecord(value) || typeof value.url !== 'string' || value.url.trim().length === 0) return invalid('http_probe requires a URL');
  const method = value.method === undefined ? 'GET' : value.method;
  if (method !== 'GET' && method !== 'HEAD') return invalid('HTTP method must be GET or HEAD');
  const timeoutSeconds = value.timeout_seconds === undefined ? 10 : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0.1 || timeoutSeconds > 30) return invalid('timeout_seconds is invalid');
  const maxBytes = value.max_bytes === undefined ? MAX_HTTP_BYTES : value.max_bytes;
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_HTTP_BYTES) return invalid('max_bytes is invalid');
  return ok({ url: value.url.trim(), method, timeoutSeconds, maxBytes });
}

function parseStorageRequest(value: unknown): Result<{ workspaceId: string; path: string; operation: 'filesystem' | 'directory' | 'largest_files' }> {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || typeof value.path !== 'string') return invalid('storage_usage requires workspaceId and path');
  const operation = value.operation === undefined ? 'filesystem' : value.operation;
  if (operation !== 'filesystem' && operation !== 'directory' && operation !== 'largest_files') return invalid('Storage operation is invalid');
  if (value.path.includes('\0') || value.path.length === 0 || value.path.length > 4096) return invalid('Path is invalid');
  return ok({ workspaceId: value.workspaceId, path: value.path, operation });
}

function boundedHeaders(headers: Headers): { value: Record<string, string>; truncated: boolean } {
  const value: Record<string, string> = {};
  let bytes = 0;
  let truncated = false;
  for (const [name, raw] of headers) {
    if (Object.keys(value).length >= MAX_HTTP_HEADERS) { truncated = true; break; }
    const headerValue = raw.length > MAX_HTTP_HEADER_VALUE ? raw.slice(0, MAX_HTTP_HEADER_VALUE) : raw;
    const size = name.length + headerValue.length;
    if (bytes + size > MAX_HTTP_HEADER_BYTES) { truncated = true; break; }
    value[name] = headerValue;
    bytes += size;
    if (headerValue.length !== raw.length) truncated = true;
  }
  return { value, truncated };
}

function isRedirect(status: number): boolean { return status === 301 || status === 302 || status === 303 || status === 307 || status === 308; }

function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata' || hostname === 'metadata.google.internal' || hostname === 'instance-data' || hostname === 'instance-data.ec2.internal' || hostname === 'metadata.azure.internal' || hostname.endsWith('.local');
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return isPrivateAddress(mapped);
    const parts = mapped.split(':');
    if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const first = Number.parseInt(parts[0]!, 16);
      const second = Number.parseInt(parts[1]!, 16);
      return isPrivateAddress(`${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`);
    }
  }
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 198 && (second === 18 || second === 19)) || first >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return true;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function relativePath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative.length === 0 ? '.' : relative;
}

function clampInteger(value: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : min;
}

function invalid(message: string): Result<never> { return err(appError('INVALID_INPUT', message)); }
function unavailable(message: string): Result<never> { return err(appError('CAPABILITY_UNAVAILABLE', message, true)); }
function cancelled(): Result<never> { return err(appError('PROCESS_TIMEOUT', 'Operator probe was cancelled or timed out', true)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

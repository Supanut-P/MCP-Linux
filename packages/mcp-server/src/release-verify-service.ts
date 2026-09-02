import path from 'node:path';
import { appError, err, ok, type Result } from '@baitonghub-linux-mcp/domain';
import type { CapabilityService } from '@baitonghub-linux-mcp/capabilities';
import type { FileActor, FileService } from '@baitonghub-linux-mcp/application';
import { releaseVerifySchema } from './tools/schemas.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_COMPONENTS = 4096;
const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type ReleaseVerifyInput = {
  readonly workspaceId: string;
  readonly version?: string | undefined;
  readonly metadataPath: string;
  readonly checksumsPath: string;
  readonly sbomPath?: string | undefined;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
};

export interface ReleaseVerifyArtifactResult {
  readonly path: string;
  readonly verified: boolean;
  readonly bytes?: number;
}

export interface ReleaseVerifyOutput {
  readonly operation: 'release_verify';
  readonly verified: boolean;
  readonly version?: string;
  readonly sourceCommit?: string;
  readonly artifacts: readonly ReleaseVerifyArtifactResult[];
  readonly sbom?: { readonly present: true; readonly componentCount: number };
  readonly reasonCodes: readonly string[];
}

export interface ReleaseVerifyServiceOptions {
  readonly file?: Pick<FileService, 'readFile'>;
  readonly capabilities?: Pick<CapabilityService, 'execute'>;
}

/** Offline, bounded release verification. It delegates file hashing to artifact_verify and never mutates. */
export class ReleaseVerifyService {
  private readonly file: Pick<FileService, 'readFile'> | undefined;
  private readonly capabilities: Pick<CapabilityService, 'execute'> | undefined;

  public constructor(options: ReleaseVerifyServiceOptions = {}) {
    this.file = options.file;
    this.capabilities = options.capabilities;
  }

  public async execute(actor: FileActor, input: ReleaseVerifyInput, signal?: AbortSignal): Promise<Result<ReleaseVerifyOutput>> {
    const parsed = releaseVerifySchema.safeParse(input);
    if (!parsed.success) return err(appError('INVALID_INPUT', 'Release verification input is invalid', false));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Release verification was cancelled', true));
    const normalized = normalizeInput(parsed.data);
    if (!normalized.ok) return normalized;
    if (this.file === undefined || this.capabilities === undefined) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Release verification provider is unavailable', true));
    }

    const metadataText = await this.readManifest(actor, normalized.value.workspaceId, normalized.value.metadataPath);
    if (!metadataText.ok) return metadataText;
    const checksumsText = await this.readManifest(actor, normalized.value.workspaceId, normalized.value.checksumsPath);
    if (!checksumsText.ok) return checksumsText;
    let sbomContent: string | undefined;
    if (normalized.value.sbomPath !== undefined) {
      const readSbom = await this.readManifest(actor, normalized.value.workspaceId, normalized.value.sbomPath);
      if (!readSbom.ok) return readSbom;
      sbomContent = readSbom.value;
    }

    const metadata = parseMetadata(metadataText.value, normalized.value.metadataPath);
    if (!metadata.ok) return ok(failureOutput(normalized.value, metadata.reasonCode));
    if (normalized.value.version !== undefined && normalized.value.version !== metadata.value.version) {
      return ok(failureOutput(normalized.value, 'metadata_mismatch'));
    }

    const checksums = parseChecksums(checksumsText.value, normalized.value.checksumsPath);
    if (!checksums.ok) return ok(failureOutput(normalized.value, checksums.reasonCode));
    for (const artifact of normalized.value.artifacts) {
      const checksum = checksums.value.get(artifact.path);
      const metadataArtifact = metadata.value.artifacts.get(artifact.path);
      if (checksum !== artifact.sha256 || metadataArtifact?.sha256 !== artifact.sha256) {
        return ok(failureOutput(normalized.value, 'checksum_mismatch'));
      }
    }

    let sbom: { readonly present: true; readonly componentCount: number } | undefined;
    if (sbomContent !== undefined) {
      const parsedSbom = parseSbom(sbomContent);
      if (!parsedSbom.ok) return ok(failureOutput(normalized.value, parsedSbom.reasonCode));
      sbom = { present: true, componentCount: parsedSbom.componentCount };
    }

    const verifiedArtifacts: ReleaseVerifyArtifactResult[] = [];
    for (const artifact of normalized.value.artifacts) {
      if (signal !== undefined && signal.aborted) return err(appError('PROCESS_TIMEOUT', 'Release verification was cancelled', true));
      let result: Result<unknown>;
      try {
        result = await this.capabilities.execute('artifact_verify', {
          workspaceId: normalized.value.workspaceId,
          path: artifact.path,
          expected_sha256: artifact.sha256,
        }, signal);
      } catch {
        return err(appError('CAPABILITY_UNAVAILABLE', 'Artifact verification provider is unavailable', true));
      }
      if (!result.ok) return err(appError('CAPABILITY_UNAVAILABLE', 'Artifact verification provider is unavailable', true));
      if (!isRecord(result.value) || result.value.matches !== true || result.value.digest !== artifact.sha256) {
        return ok(failureOutput(normalized.value, 'artifact_mismatch'));
      }
      const bytes = typeof result.value.bytes === 'number' && Number.isSafeInteger(result.value.bytes) && result.value.bytes >= 0
        ? result.value.bytes
        : undefined;
      verifiedArtifacts.push({ path: artifact.path, verified: true, ...(bytes === undefined ? {} : { bytes }) });
    }

    const output: ReleaseVerifyOutput = {
      operation: 'release_verify',
      verified: true,
      version: metadata.value.version,
      sourceCommit: metadata.value.sourceCommit,
      artifacts: verifiedArtifacts,
      ...(sbom === undefined ? {} : { sbom }),
      reasonCodes: [],
    };
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_MANIFEST_BYTES) {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Release verification result exceeded the size limit', true));
    }
    return ok(output);
  }

  private async readManifest(actor: FileActor, workspaceId: string, manifestPath: string): Promise<Result<string>> {
    if (this.file === undefined) return err(appError('CAPABILITY_UNAVAILABLE', 'Release verification provider is unavailable', true));
    let result: Awaited<ReturnType<FileService['readFile']>>;
    try {
      result = await this.file.readFile(actor, workspaceId, { path: manifestPath });
    } catch {
      return err(appError('CAPABILITY_UNAVAILABLE', 'Release manifest could not be read', true));
    }
    if (!result.ok) return err(appError('CAPABILITY_UNAVAILABLE', 'Release manifest could not be read', true));
    if (result.value.encoding !== undefined && result.value.encoding !== 'utf8') {
      return err(appError('INVALID_INPUT', 'Release manifest must be UTF-8 text', false));
    }
    const bytes = result.value.byteLength ?? Buffer.byteLength(result.value.content, 'utf8');
    if (bytes > MAX_MANIFEST_BYTES) return err(appError('INVALID_INPUT', 'Release manifest exceeds the size limit', false));
    return ok(result.value.content);
  }
}

interface NormalizedInput {
  readonly workspaceId: string;
  readonly version?: string | undefined;
  readonly metadataPath: string;
  readonly checksumsPath: string;
  readonly sbomPath?: string | undefined;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
}

interface MetadataValue {
  readonly version: string;
  readonly sourceCommit: string;
  readonly artifacts: ReadonlyMap<string, { readonly sha256: string; readonly bytes?: number }>;
}

function normalizeInput(input: ReleaseVerifyInput): Result<NormalizedInput> {
  const metadataPath = normalizeRelativePath(input.metadataPath);
  const checksumsPath = normalizeRelativePath(input.checksumsPath);
  const sbomPath = input.sbomPath === undefined ? ok<string | undefined>(undefined) : normalizeRelativePath(input.sbomPath);
  if (!metadataPath.ok || !checksumsPath.ok || !sbomPath.ok) return err(appError('INVALID_INPUT', 'Release manifest paths must be relative to the workspace', false));
  const artifacts: Array<{ readonly path: string; readonly sha256: string }> = [];
  const seen = new Set<string>();
  for (const artifact of input.artifacts) {
    const normalizedArtifact = normalizeRelativePath(artifact.path);
    if (!normalizedArtifact.ok || seen.has(normalizedArtifact.value)) return err(appError('INVALID_INPUT', 'Release artifact paths must be unique relative paths', false));
    seen.add(normalizedArtifact.value);
    artifacts.push({ path: normalizedArtifact.value, sha256: artifact.sha256.toLowerCase() });
  }
  return ok({
    workspaceId: input.workspaceId,
    ...(input.version === undefined ? {} : { version: input.version }),
    metadataPath: metadataPath.value,
    checksumsPath: checksumsPath.value,
    ...(sbomPath.value === undefined ? {} : { sbomPath: sbomPath.value }),
    artifacts,
  });
}

function normalizeRelativePath(value: string): Result<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
    return err(appError('INVALID_INPUT', 'Release manifest path is invalid', false));
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return err(appError('INVALID_INPUT', 'Release manifest path escapes the workspace', false));
  }
  return ok(normalized);
}

type VerificationParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reasonCode: string };

function parseMetadata(text: string, manifestPath: string): VerificationParse<MetadataValue> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reasonCode: 'metadata_mismatch' }; }
  if (!isRecord(value) || value.schema !== 'baitonghub.release-provenance.v1' || value.product !== 'Baitonghub-Linux-mcp' || typeof value.version !== 'string' || !VERSION.test(value.version) || typeof value.sourceCommit !== 'string' || !COMMIT.test(value.sourceCommit) || value.sourceDirty !== false || !Array.isArray(value.artifacts)) {
    return { ok: false, reasonCode: 'metadata_mismatch' };
  }
  const artifacts = new Map<string, { readonly sha256: string; readonly bytes?: number }>();
  const base = path.posix.dirname(manifestPath);
  for (const entry of value.artifacts) {
    if (!isRecord(entry)) return { ok: false, reasonCode: 'metadata_mismatch' };
    const file = entry.file;
    const sha256 = entry.sha256;
    const bytes = entry.bytes;
    if (typeof file !== 'string' || typeof sha256 !== 'string' || !SHA256.test(sha256) || (bytes !== undefined && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0))) {
      return { ok: false, reasonCode: 'metadata_mismatch' };
    }
    const resolved = resolveManifestPath(base, file);
    if (!resolved.ok || artifacts.has(resolved.value)) return { ok: false, reasonCode: 'metadata_mismatch' };
    artifacts.set(resolved.value, { sha256: sha256.toLowerCase(), ...(bytes === undefined ? {} : { bytes }) });
  }
  const version = value.version;
  const sourceCommit = value.sourceCommit;
  if (typeof version !== 'string' || typeof sourceCommit !== 'string') return { ok: false, reasonCode: 'metadata_mismatch' };
  return { ok: true, value: { version, sourceCommit: sourceCommit.toLowerCase(), artifacts } };
}

function parseChecksums(text: string, manifestPath: string): VerificationParse<ReadonlyMap<string, string>> {
  const entries = new Map<string, string>();
  const base = path.posix.dirname(manifestPath);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (match === null) return { ok: false, reasonCode: 'checksum_mismatch' };
    const checksum = match[1];
    const file = match[2];
    if (checksum === undefined || file === undefined) return { ok: false, reasonCode: 'checksum_mismatch' };
    const resolved = resolveManifestPath(base, file);
    if (!resolved.ok || entries.has(resolved.value)) return { ok: false, reasonCode: 'checksum_mismatch' };
    entries.set(resolved.value, checksum.toLowerCase());
  }
  return { ok: true, value: entries };
}

function parseSbom(text: string): { readonly ok: true; readonly componentCount: number } | { readonly ok: false; readonly reasonCode: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reasonCode: 'sbom_mismatch' }; }
  if (!isRecord(value) || value.bomFormat !== 'CycloneDX' || (value.specVersion !== '1.4' && value.specVersion !== '1.5') || !Array.isArray(value.components) || value.components.length > MAX_COMPONENTS || value.components.some((component) => !isRecord(component) || typeof component.name !== 'string' || typeof component.version !== 'string')) {
    return { ok: false, reasonCode: 'sbom_mismatch' };
  }
  return { ok: true, componentCount: value.components.length };
}

function resolveManifestPath(base: string, entry: string): Result<string> {
  if (entry.length === 0 || entry.includes('\0') || entry.includes('\\') || path.posix.isAbsolute(entry)) return err(appError('INVALID_INPUT', 'Release manifest entry is invalid', false));
  return normalizeRelativePath(base === '.' ? entry : `${base}/${entry}`);
}

function failureOutput(input: NormalizedInput, reasonCode: string): ReleaseVerifyOutput {
  return {
    operation: 'release_verify',
    verified: false,
    ...(input.version === undefined ? {} : { version: input.version }),
    artifacts: input.artifacts.map((artifact) => ({ path: artifact.path, verified: false })),
    reasonCodes: [reasonCode],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

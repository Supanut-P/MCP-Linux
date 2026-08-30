import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDirectory = path.resolve(repositoryRoot, process.argv[2] ?? 'dist');
const packageManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = packageManifest.version;
const packageName = packageManifest.name;
const artifactNames = [
  `Baitonghub-Linux-mcp-${version}-amd64.deb`,
  `Baitonghub-Linux-mcp-${version}-linux-x64.tar.gz`,
  `Baitonghub-Linux-mcp-${version}-SHA256SUMS`,
];
for (const artifactName of artifactNames) await stat(path.join(artifactDirectory, artifactName));

const sourceCommitOverride = process.env.BAITONGHUB_LINUX_MCP_SOURCE_COMMIT?.trim();
const commit = sourceCommitOverride || gitOutput(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('release provenance requires a full source commit SHA');
const dirty = sourceCommitOverride ? false : gitOutput(['status', '--porcelain']) !== '';
if (dirty) throw new Error('release provenance requires a clean Git worktree');

const artifactEntries = [];
for (const artifactName of artifactNames) {
  const artifactPath = path.join(artifactDirectory, artifactName);
  artifactEntries.push({ file: artifactName, bytes: (await stat(artifactPath)).size, sha256: await sha256(artifactPath) });
}

const generatedAt = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '', 10);
const timestamp = Number.isFinite(generatedAt)
  ? new Date(generatedAt * 1000).toISOString()
  : new Date().toISOString();
const metadata = {
  schema: 'baitonghub.release-provenance.v1',
  product: 'Baitonghub-Linux-mcp',
  package: packageName,
  version,
  sourceCommit: commit,
  sourceDirty: false,
  generatedAt: timestamp,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  artifacts: artifactEntries,
};
const metadataName = `Baitonghub-Linux-mcp-${version}-BUILD-METADATA.json`;
const sbomName = `Baitonghub-Linux-mcp-${version}-SBOM.cdx.json`;
const provenanceSumsName = `Baitonghub-Linux-mcp-${version}-PROVENANCE-SHA256SUMS`;
await writeFile(path.join(artifactDirectory, metadataName), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

const components = await workspaceComponents();
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${stableUuid(`${packageName}@${version}:${commit}`)}`,
  version: 1,
  metadata: {
    timestamp,
    component: { type: 'application', name: packageName, version, 'bom-ref': `${packageName}@${version}` },
    properties: [{ name: 'source.commit', value: commit }],
  },
  components,
};
await writeFile(path.join(artifactDirectory, sbomName), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');

const provenanceEntries = [...artifactEntries, metadataName, sbomName];
const provenanceLines = [];
for (const entry of provenanceEntries) {
  const file = typeof entry === 'string' ? entry : entry.file;
  provenanceLines.push(`${await sha256(path.join(artifactDirectory, file))}  ${file}`);
}
await writeFile(path.join(artifactDirectory, provenanceSumsName), `${provenanceLines.join('\n')}\n`, 'utf8');
process.stdout.write(`Release provenance generated for ${packageName} v${version} at ${artifactDirectory}.\n`);

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`Git source metadata unavailable; set BAITONGHUB_LINUX_MCP_SOURCE_COMMIT only for an exported source tree (${args.join(' ')})`);
  }
}

async function sha256(filePath) {
  const digest = createHash('sha256');
  digest.update(await readFile(filePath));
  return digest.digest('hex');
}

async function workspaceComponents() {
  const components = new Map();
  const workspaceDirectories = [path.join(repositoryRoot, 'apps'), path.join(repositoryRoot, 'packages')];
  for (const parent of workspaceDirectories) {
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(parent, entry.name, 'package.json'), 'utf8'));
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
          components.set(`${manifest.name}@${manifest.version}`, {
            type: 'library',
            name: manifest.name,
            version: manifest.version,
            'bom-ref': `${manifest.name}@${manifest.version}`,
            purl: `pkg:npm/${encodeURIComponent(manifest.name)}@${manifest.version}`,
          });
        }
      } catch {
        // Ignore non-package workspace directories.
      }
    }
  }
  return [...components.values()].sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));
}

function stableUuid(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

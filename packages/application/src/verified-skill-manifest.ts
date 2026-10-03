import type { WorkflowRole } from '@baitonghub-linux-mcp/codex';

export interface VerifiedSkillPin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: 'repo-local';
  readonly path: string;
  readonly reviewRevision: 'review-2026-10-03.1';
  readonly reviewStatus: 'reviewed';
  readonly scope: 'single_document';
  readonly sha256: string;
  readonly roles: readonly WorkflowRole[];
}

export const VERIFIED_SKILL_LICENSE = {
  path: 'LICENSE',
  sha256: '0c9743c18bc3018ab934818eb1481ba790c29b07814d20e7db3e60fd6b626dc8',
} as const;

export const VERIFIED_SKILL_MANIFEST: readonly VerifiedSkillPin[] = [
  {
    id: 'mcp-linux-development',
    name: 'MCP Linux development',
    description: 'Implement or change Baitonghub Linux MCP code and docs with scoped edits, bounded worker help, and repo-specific verification.',
    source: 'repo-local', path: 'docs/skills/mcp-linux-development/SKILL.md',
    reviewRevision: 'review-2026-10-03.1', reviewStatus: 'reviewed', scope: 'single_document',
    sha256: 'fc79f183e47bc02a86caf0f604f9708981281f9589004b39210f392a8b932055',
    roles: ['lead', 'worker', 'qa', 'planner'],
  },
  {
    id: 'mcp-linux-incident',
    name: 'MCP Linux incident triage',
    description: 'Triage Baitonghub Linux MCP or registered-host incidents using bounded read-only evidence and explicit confidence labels.',
    source: 'repo-local', path: 'docs/skills/mcp-linux-incident/SKILL.md',
    reviewRevision: 'review-2026-10-03.1', reviewStatus: 'reviewed', scope: 'single_document',
    sha256: 'dde2f7a84e41cafc270d13a0274caf4f590671379be66a3b7d7abb08186c5f85',
    roles: ['lead', 'worker', 'qa', 'planner'],
  },
  {
    id: 'mcp-linux-release',
    name: 'MCP Linux release preparation',
    description: 'Prepare and verify Baitonghub Linux MCP release candidates against the exact source, Ubuntu package, contract, and acceptance gates.',
    source: 'repo-local', path: 'docs/skills/mcp-linux-release/SKILL.md',
    reviewRevision: 'review-2026-10-03.1', reviewStatus: 'reviewed', scope: 'single_document',
    sha256: '30e91550dfa1c23b788ef624d83e9c415ec80cd30e78d597ea07a3db35782d82',
    roles: ['lead', 'qa'],
  },
];

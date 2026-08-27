export const UNRESTRICTED_SETTING_KEY = 'unrestricted_mode';

export type ProcessEnvLike = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const FALSE_VALUES = new Set(['0', 'false', 'off', 'no']);

function parseFlag(value: string | null | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized.length === 0) return undefined;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

export function unrestrictedFromEnv(env: ProcessEnvLike = process.env): boolean {
  return parseFlag(env.BAITONGHUB_LINUX_MCP_UNRESTRICTED) === true;
}

export function unrestrictedFromSetting(value: string | null | undefined): boolean {
  return parseFlag(value) === true;
}

/** Missing env+setting defaults to ON so agents can use every registered Linux root. */
export function isUnrestricted(env: ProcessEnvLike, settingValue: string | null | undefined): boolean {
  const fromEnv = parseFlag(env.BAITONGHUB_LINUX_MCP_UNRESTRICTED);
  if (fromEnv !== undefined) return fromEnv;
  const fromSetting = parseFlag(settingValue);
  if (fromSetting !== undefined) return fromSetting;
  return true;
}

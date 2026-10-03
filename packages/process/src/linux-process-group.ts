import { closeSync, openSync, opendirSync, readSync } from 'node:fs';

export interface LinuxGroupMember {
  readonly pid: number;
  readonly groupId: number;
  readonly sessionId: number;
  readonly startTime: string;
  readonly state: string;
}

const MAX_STAT_BYTES = 4096;
const MAX_PROC_ENTRIES = 8192;
const MAX_GROUP_MEMBERS = 256;
const MAX_SCAN_MS = 100;

export function parseLinuxProcessStat(pid: number, stat: string): LinuxGroupMember {
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const parsedPid = Number(stat.slice(0, stat.indexOf(' ')));
  const groupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  if (end < 0 || parsedPid !== pid || !Number.isSafeInteger(groupId) || groupId < 0 || !Number.isSafeInteger(sessionId) || sessionId < 0 || typeof startTime !== 'string' || !/^\d+$/.test(startTime) || !/^[RSDZTtWXIP]$/.test(fields[0] ?? '')) {
    throw new Error('Linux process identity is malformed');
  }
  return { pid, groupId, sessionId, startTime, state: fields[0]! };
}

export function readLinuxGroupMember(pid: number): LinuxGroupMember {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Linux process identity is unavailable');
  const handle = openSync(`/proc/${pid}/stat`, 'r');
  try {
    const bytes = Buffer.alloc(MAX_STAT_BYTES + 1);
    const count = readSync(handle, bytes, 0, bytes.length, 0);
    if (count > MAX_STAT_BYTES) throw new Error('Linux process identity exceeded its bound');
    return parseLinuxProcessStat(pid, bytes.subarray(0, count).toString('utf8'));
  } finally { closeSync(handle); }
}

/** Bounded metadata-only observation; unreadable entries cannot prove completeness. */
export function readLinuxGroupMembers(groupId: number): readonly LinuxGroupMember[] {
  if (process.platform !== 'linux') throw new Error('Linux process group observation is unavailable');
  const directory = opendirSync('/proc');
  const deadline = Date.now() + MAX_SCAN_MS;
  const members: LinuxGroupMember[] = [];
  let entries = 0;
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++entries > MAX_PROC_ENTRIES || Date.now() > deadline) throw new Error('Linux process group observation exceeded its bound');
      if (!/^\d+$/.test(entry.name) || Number(entry.name) <= 1) continue;
      let member: LinuxGroupMember;
      try { member = readLinuxGroupMember(Number(entry.name)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        throw new Error('Linux process group observation is incomplete');
      }
      if (member.groupId === groupId) {
        if (members.length >= MAX_GROUP_MEMBERS) throw new Error('Linux process group member limit exceeded');
        members.push(member);
      }
    }
    return members;
  } finally { directory.closeSync(); }
}

export function sameLinuxGroupMember(a: LinuxGroupMember, b: LinuxGroupMember): boolean {
  return a.pid === b.pid && a.groupId === b.groupId && a.sessionId === b.sessionId && a.startTime === b.startTime;
}

export function memberMayExecute(member: LinuxGroupMember): boolean {
  return member.state !== 'Z' && member.state !== 'X';
}

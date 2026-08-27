import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { ActivitySink, ActivitySinkEvent } from './activity-tracker.js';

export function mcpActivityLogPath(dataPath: string): string {
  return path.join(dataPath, 'mcp-activity.log');
}

export function formatActivityLogLine(event: ActivitySinkEvent): string {
  return `${JSON.stringify({
    callId: event.callId,
    toolName: event.toolName,
    phase: event.phase,
    resultCode: event.resultCode,
    durationMs: event.durationMs,
    timestamp: event.timestamp,
    ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.targetSummary === undefined ? {} : { targetSummary: event.targetSummary }),
    ...(event.resultMessage === undefined ? {} : { resultMessage: event.resultMessage }),
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    ...(event.traceParent === undefined ? {} : { traceParent: event.traceParent }),
  })}\n`;
}

export function createFileActivitySink(filePath: string): ActivitySink {
  return {
    async record(event: ActivitySinkEvent): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, formatActivityLogLine(event), 'utf8');
    },
  };
}

export function composeActivitySinks(sinks: readonly ActivitySink[]): ActivitySink {
  return {
    async record(event: ActivitySinkEvent): Promise<void> {
      const errors: unknown[] = [];
      for (const sink of sinks) {
        try {
          await sink.record(event);
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
  };
}

import type { DoctorReport, DoctorService } from '@baitonghub-linux-mcp/application';

export interface DoctorCommandRunner {
  run(): Promise<DoctorReport>;
}

export function formatDoctorReport(report: DoctorReport): string {
  return report.checks
    .map((check) => `[${check.status.toUpperCase()}] ${check.id}: ${check.message}`)
    .join('\n');
}

export async function runDoctorCommand(
  service: Pick<DoctorService, 'run'> | DoctorCommandRunner,
  write: (text: string) => void,
): Promise<number> {
  const report = await service.run();
  write(formatDoctorReport(report));
  return report.exitCode;
}

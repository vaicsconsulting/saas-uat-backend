export const REPORT_TZ = process.env.REPORT_TZ ?? 'Asia/Kolkata';

export function fmtDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: REPORT_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}-${g('month')}-${g('year')} ${g('hour')}:${g('minute')}`;
}

export function fmtDate(iso: string | Date | null | undefined): string {
  return fmtDateTime(iso).slice(0, 10);
}

export const STATUS_LABEL: Record<string, string> = {
  NOT_RUN: 'Not run',
  PASS: 'Pass',
  FAIL: 'Fail',
  BLOCKED: 'Blocked',
};

export const DEFECT_LABEL: Record<string, string> = {
  OPEN: 'Open',
  FIXED: 'Fixed',
  RETEST_PASSED: 'Retest passed',
  RETEST_FAILED: 'Retest failed',
  CLOSED: 'Closed',
};

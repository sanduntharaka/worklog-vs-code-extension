const pad = (n: number) => String(n).padStart(2, '0');

/** Local date as YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today(): string {
  return dayKey(Date.now());
}

export function startOfDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function endOfDay(date: string): number {
  return startOfDay(addDays(date, 1)) - 1;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + days).getTime());
}

export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "HH:mm" on the given date to a timestamp, or undefined if malformed. */
export function parseHHMM(date: string, value: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) {
    return undefined;
  }
  return startOfDay(date) + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
}

export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}

export function formatDate(date: string): string {
  return new Date(startOfDay(date)).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function roundMinutes(minutes: number, step: number): number {
  if (step <= 0) {
    return Math.round(minutes);
  }
  return Math.max(step, Math.round(minutes / step) * step);
}

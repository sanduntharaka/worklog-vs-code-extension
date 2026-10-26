import { Store } from './store';
import { stripKey, taskLabel } from './tasks';
import { formatDate, formatDuration, hhmm, parseHHMM, roundMinutes } from './time';
import { CommitRef, Note, RowOverride, TaskInfo } from './types';

/** One timesheet line: everything done on one task during one day. */
export interface TaskRow {
  key: string;
  title: string;
  kind: TaskInfo['kind'];
  label: string;
  start: string;
  end: string;
  /** Minutes going to the timesheet (rounded, or overridden). */
  minutes: number;
  /** Minutes actually tracked as active, before rounding/overrides. */
  trackedMinutes: number;
  description: string;
  autoDescription: string;
  commits: string[];
  notes: string[];
  edited: boolean;
  /** Description was last written by a coding agent (via the MCP tool), not by hand. */
  summaryByAgent: boolean;
  hidden: boolean;
  added: boolean;
  active: boolean;
  sortKey: number;
}

export interface DayReport {
  date: string;
  dateLabel: string;
  rows: TaskRow[];
  totalMinutes: number;
}

interface Collected {
  info: TaskInfo;
  intervals: Array<[number, number]>;
  commits: Map<string, CommitRef>;
  notes: Note[];
}

export function buildDay(store: Store, date: string, activeKey?: string, roundTo = 0): DayReport {
  const collected = new Map<string, Collected>();
  const get = (key: string, info?: TaskInfo): Collected => {
    let c = collected.get(key);
    if (!c) {
      c = { info: info ?? { key, title: key, kind: 'jira' }, intervals: [], commits: new Map(), notes: [] };
      collected.set(key, c);
    }
    return c;
  };

  for (const file of store.readDay(date)) {
    for (const s of file.segments) {
      get(s.taskKey, file.tasks[s.taskKey]).intervals.push([s.start, s.end]);
    }
    for (const [key, commits] of Object.entries(file.commits)) {
      const c = get(key, file.tasks[key]);
      commits.forEach(commit => c.commits.set(commit.message, commit));
    }
    for (const [key, notes] of Object.entries(file.notes)) {
      get(key, file.tasks[key]).notes.push(...notes);
    }
  }

  const overrides = store.readOverrides(date);
  const rows: TaskRow[] = [];

  for (const [key, c] of collected) {
    const merged = mergeIntervals(c.intervals);
    const trackedMinutes = merged.reduce((sum, [a, b]) => sum + (b - a), 0) / 60_000;
    const commits = [...c.commits.values()].sort((a, b) => a.time - b.time);
    const notes = c.notes.sort((a, b) => a.time - b.time).map(n => n.text);
    const o = overrides[key] ?? {};
    // Skip blips (e.g. a quick look at another branch) unless there's something to report.
    if (trackedMinutes < 1 && !commits.length && !notes.length && !o.description && key !== activeKey) {
      continue;
    }
    const first = merged[0]?.[0] ?? commits[0]?.time ?? Date.now();
    const last = merged[merged.length - 1]?.[1] ?? commits[commits.length - 1]?.time ?? first;
    const commitLines = commits.map(cm => capitalize(stripKey(cm.message, key)));
    const autoDescription = [...commitLines, ...notes].join('; ');
    const title = o.title ?? (c.info.kind === 'jira' ? store.getTitle(key) : undefined) ?? c.info.title;
    rows.push({
      key,
      title,
      kind: c.info.kind,
      label: taskLabel({ key, title, kind: c.info.kind }),
      start: o.start ?? hhmm(first),
      end: o.end ?? hhmm(last),
      minutes: o.minutes ?? roundMinutes(trackedMinutes, roundTo),
      trackedMinutes: Math.round(trackedMinutes),
      description: o.description ?? autoDescription,
      autoDescription,
      commits: commitLines,
      notes,
      edited: isEditedByUser(o),
      summaryByAgent: o.descriptionBy === 'agent',
      hidden: !!o.hidden,
      added: false,
      active: key === activeKey,
      sortKey: parseHHMM(date, o.start ?? '') ?? first,
    });
  }

  for (const [key, o] of Object.entries(overrides)) {
    // An agent summary can arrive before any time is tracked; once tracking starts, the row above takes over.
    if (!o.added || collected.has(key)) {
      continue;
    }
    const title = o.title ?? key;
    const kind = key.startsWith('manual:') ? 'manual' : 'jira';
    rows.push({
      key,
      title,
      kind,
      label: taskLabel({ key, title, kind }),
      start: o.start ?? '',
      end: o.end ?? '',
      minutes: o.minutes ?? 0,
      trackedMinutes: 0,
      description: o.description ?? '',
      autoDescription: '',
      commits: [],
      notes: [],
      edited: true,
      summaryByAgent: o.descriptionBy === 'agent',
      hidden: !!o.hidden,
      added: true,
      active: false,
      sortKey: parseHHMM(date, o.start ?? '') ?? Number.MAX_SAFE_INTEGER,
    });
  }

  rows.sort((a, b) => a.sortKey - b.sortKey);
  const totalMinutes = rows.filter(r => !r.hidden).reduce((sum, r) => sum + r.minutes, 0);
  return { date, dateLabel: formatDate(date), rows, totalMinutes };
}

/** Plain text for pasting into the Odoo timesheet form. */
export function toText(report: DayReport): string {
  const lines = [`${report.dateLabel} — total ${formatDuration(report.totalMinutes)}`, ''];
  for (const row of report.rows.filter(r => !r.hidden)) {
    lines.push(rowToText(row), '');
  }
  return lines.join('\n').trimEnd();
}

export function rowToText(row: TaskRow): string {
  const heading = row.kind === 'jira' && row.title !== row.key ? `${row.key} — ${row.title}` : row.title;
  const lines = [heading];
  if (row.start || row.end || row.minutes) {
    lines.push(`${row.start || '?'}–${row.end || '?'} (${formatDuration(row.minutes)})`);
  }
  if (row.description) {
    lines.push(row.description);
  }
  return lines.join('\n');
}

export function toCsv(report: DayReport): string {
  const header = ['Date', 'Task', 'Title', 'Start', 'End', 'Hours', 'Description'];
  const body = report.rows
    .filter(r => !r.hidden)
    .map(r => [
      report.date,
      r.kind === 'jira' ? r.key : '',
      r.title,
      r.start,
      r.end,
      (r.minutes / 60).toFixed(2),
      r.description,
    ]);
  return [header, ...body].map(cols => cols.map(csvCell).join(',')).join('\r\n');
}

/** True when the user changed something in the timesheet (an agent summary alone doesn't count). */
function isEditedByUser(o: RowOverride): boolean {
  return Object.keys(o).some(
    k => !['hidden', 'added', 'descriptionBy'].includes(k) && !(k === 'description' && o.descriptionBy),
  );
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

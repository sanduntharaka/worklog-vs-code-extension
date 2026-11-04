import { Store } from './store';
import { stripKey, taskLabel } from './tasks';
import { formatDate, formatHHMM, hhmm, parseHHMM, roundMinutes } from './time';
import { CommitRef, Note, RowOverride, TaskInfo } from './types';

/** Entries shorter than this round to 00:00 with 15-minute steps; flagged so the user decides. */
const TINY_MINUTES = 8;

// "Work", "Emails", "Meeting"… — the Odoo procedure asks for specific descriptions.
const GENERIC = /^(work(ing)?|e-?mails?|meetings?|misc(ellaneous)?|fix(es|ed)?|bug ?fix(es)?|dev(elopment)?|coding|support|general|tasks?|stuff|various|other|testing|review)\.?$/i;

/** One timesheet line: everything done on one task during one day = one Odoo entry. */
export interface TaskRow {
  key: string;
  /** Key without the "#2" suffix of hand-added duplicates. */
  displayKey: string;
  title: string;
  kind: TaskInfo['kind'];
  label: string;
  start: string;
  end: string;
  /** Odoo project. */
  project: string;
  /** The project was suggested from earlier entries, not chosen for this entry. */
  projectSuggested: boolean;
  repo?: string;
  /** "Time Spent" for the whole day: rounded to the configured step, or as overridden. */
  minutes: number;
  /** Already entered in Odoo. */
  loggedMinutes: number;
  /** Still to enter in Odoo (minutes − logged). */
  toLogMinutes: number;
  /** Minutes actually tracked as active, before rounding/overrides. */
  trackedMinutes: number;
  /** What the user (or agent) wrote, without the [KEY] prefix. */
  description: string;
  autoDescription: string;
  /** The text for Odoo's Description field: "[TEST-101] Added …." or "Meeting – Planned …." */
  odooDescription: string;
  commits: string[];
  notes: string[];
  /** Things the Odoo procedure would reject; empty when the entry is ready. */
  issues: string[];
  edited: boolean;
  /** Description was last written by a coding agent (via the MCP tool), not by hand. */
  summaryByAgent: boolean;
  hidden: boolean;
  added: boolean;
  active: boolean;
  sortKey: number;
}

export interface DayCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface DayReport {
  date: string;
  dateLabel: string;
  rows: TaskRow[];
  totalMinutes: number;
  toLogMinutes: number;
  /** End-of-day verification from the Odoo procedure. */
  checks: DayCheck[];
  roundTo: number;
}

interface Collected {
  info: TaskInfo;
  intervals: Array<[number, number]>;
  commits: Map<string, CommitRef>;
  notes: Note[];
  repo?: string;
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
      const c = get(s.taskKey, file.tasks[s.taskKey]);
      c.intervals.push([s.start, s.end]);
      c.repo = s.repo ?? c.repo;
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
  const memory = store.getProjectMemory();
  const rows: TaskRow[] = [];

  const suggestProject = (key: string, kind: TaskInfo['kind'], repo?: string) =>
    memory.byTask[baseKey(key)] ?? (kind !== 'manual' && repo ? memory.byRepo[repo] : undefined) ?? '';

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
    rows.push(
      finishRow(
        {
          key,
          title,
          kind: c.info.kind,
          start: o.start ?? hhmm(first),
          end: o.end ?? hhmm(last),
          repo: c.repo,
          minutes: o.minutes ?? roundMinutes(trackedMinutes, roundTo),
          trackedMinutes: Math.round(trackedMinutes),
          description: o.description ?? autoDescription,
          autoDescription,
          commits: commitLines,
          notes,
          edited: isEditedByUser(o),
          added: false,
          active: key === activeKey,
          sortKey: parseHHMM(date, o.start ?? '') ?? first,
        },
        o,
        suggestProject(key, c.info.kind, c.repo),
        roundTo,
      ),
    );
  }

  for (const [key, o] of Object.entries(overrides)) {
    // An agent summary can arrive before any time is tracked; once tracking starts, the row above takes over.
    if (!o.added || collected.has(key)) {
      continue;
    }
    const kind = key.startsWith('manual:') ? 'manual' : 'jira';
    rows.push(
      finishRow(
        {
          key,
          title: o.title ?? key,
          kind,
          start: o.start ?? '',
          end: o.end ?? '',
          minutes: o.minutes ?? 0,
          trackedMinutes: 0,
          description: o.description ?? '',
          autoDescription: '',
          commits: [],
          notes: [],
          edited: true,
          added: true,
          active: false,
          sortKey: parseHHMM(date, o.start ?? '') ?? Number.MAX_SAFE_INTEGER,
        },
        o,
        suggestProject(key, kind),
        roundTo,
      ),
    );
  }

  rows.sort((a, b) => a.sortKey - b.sortKey);
  const visible = rows.filter(r => !r.hidden);
  const totalMinutes = visible.reduce((sum, r) => sum + r.minutes, 0);
  const toLogMinutes = visible.reduce((sum, r) => sum + r.toLogMinutes, 0);
  return {
    date,
    dateLabel: formatDate(date),
    rows,
    totalMinutes,
    toLogMinutes,
    checks: dayChecks(visible, toLogMinutes, roundTo),
    roundTo,
  };
}

type RowBase = Omit<
  TaskRow,
  | 'displayKey'
  | 'label'
  | 'project'
  | 'projectSuggested'
  | 'loggedMinutes'
  | 'toLogMinutes'
  | 'odooDescription'
  | 'issues'
  | 'summaryByAgent'
  | 'hidden'
>;

/** Add the Odoo fields (project, logged time, formatted description) and the procedure checks. */
function finishRow(base: RowBase, o: RowOverride, suggested: string, roundTo: number): TaskRow {
  const displayKey = baseKey(base.key);
  const project = o.project ?? suggested;
  const loggedMinutes = o.loggedMinutes ?? 0;
  const row: TaskRow = {
    ...base,
    displayKey,
    label: taskLabel({ key: displayKey, title: base.title, kind: base.kind }),
    project,
    projectSuggested: !o.project && !!project,
    loggedMinutes,
    toLogMinutes: Math.max(0, base.minutes - loggedMinutes),
    odooDescription: '',
    issues: [],
    summaryByAgent: o.descriptionBy === 'agent',
    hidden: !!o.hidden,
  };
  row.odooDescription = odooDescription(row);
  row.issues = rowIssues(row, roundTo);
  return row;
}

/** Odoo "Description": "[TEST-101] Added date filter." / "Meeting – Planned the sprint." */
export function odooDescription(row: Pick<TaskRow, 'kind' | 'displayKey' | 'title' | 'description'>): string {
  const isJira = row.kind === 'jira' && !row.displayKey.startsWith('manual:');
  const body = sentence(isJira ? stripKey(row.description, row.displayKey) : row.description);
  if (isJira) {
    return `[${row.displayKey}] ${body || sentence(row.title === row.displayKey ? '' : row.title)}`.trim();
  }
  return body ? `${row.title} – ${body}` : row.title;
}

function rowIssues(row: TaskRow, roundTo: number): string[] {
  const issues: string[] = [];
  if (!row.project.trim()) {
    issues.push('Choose a project');
  }
  const body = stripKey(row.description, row.displayKey).trim();
  if (!body) {
    const usesTitle = row.kind === 'jira' && row.title && row.title !== row.displayKey;
    issues.push(usesTitle ? 'Add a description of what you did — the Jira title is used for now' : 'Add a description of what you did');
  } else if (GENERIC.test(body) || body.split(/\s+/).length < 3) {
    issues.push('Description is too generic — say what was done');
  }
  if (row.minutes === 0 && row.trackedMinutes > 0 && row.trackedMinutes < TINY_MINUTES) {
    issues.push(`Only ${row.trackedMinutes} min — rounds to 00:00. Group it with a related entry, set a time, or hide it`);
  } else if (row.minutes === 0) {
    issues.push('Set the time spent');
  } else if (roundTo > 0 && row.minutes % roundTo !== 0) {
    issues.push(`Time is not a ${roundTo}-minute step`);
  }
  return issues;
}

function dayChecks(rows: TaskRow[], toLogMinutes: number, roundTo: number): DayCheck[] {
  const count = (predicate: (r: TaskRow) => boolean) => rows.filter(predicate).length;
  const noProject = count(r => !r.project.trim());
  const vague = count(r => r.issues.some(i => i.startsWith('Add a description') || i.startsWith('Description is')));
  const badTime = count(r => r.issues.some(i => i.startsWith('Only') || i.startsWith('Set the time') || i.startsWith('Time is')));
  const plural = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
  return [
    { label: 'Every entry has a project', ok: !noProject, detail: noProject ? `${plural(noProject)} without a project` : undefined },
    { label: 'Descriptions are clear and specific', ok: !vague, detail: vague ? `${plural(vague)} to improve` : undefined },
    {
      label: roundTo > 0 ? `Times follow ${roundTo}-minute steps` : 'Times are set',
      ok: !badTime,
      detail: badTime ? `${plural(badTime)} to fix` : undefined,
    },
    {
      label: 'Everything is logged in Odoo',
      ok: toLogMinutes === 0,
      detail: toLogMinutes ? `${formatHHMM(toLogMinutes)} still to log` : undefined,
    },
  ];
}

/** Plain text for the Odoo form, one block per entry, with the time still to log. */
export function toText(report: DayReport): string {
  const visible = report.rows.filter(r => !r.hidden);
  const lines = [
    `${report.dateLabel} — ${formatHHMM(report.totalMinutes)} total` +
      (report.toLogMinutes && report.toLogMinutes !== report.totalMinutes ? `, ${formatHHMM(report.toLogMinutes)} still to log` : ''),
    '',
  ];
  for (const row of visible) {
    lines.push(rowToText(row), '');
  }
  return lines.join('\n').trimEnd();
}

export function rowToText(row: TaskRow): string {
  const time = row.toLogMinutes > 0 && row.loggedMinutes > 0 ? row.toLogMinutes : row.minutes;
  return [
    `Project:     ${row.project || '(choose a project)'}`,
    `Description: ${row.odooDescription}`,
    `Time Spent:  ${formatHHMM(time)}${row.loggedMinutes > 0 && row.toLogMinutes > 0 ? ` (remaining; ${formatHHMM(row.loggedMinutes)} already logged)` : ''}`,
  ].join('\n');
}

/** Columns in the order of the Odoo form. */
export function toCsv(report: DayReport): string {
  const header = ['Date', 'Project', 'Description', 'Time Spent'];
  const body = report.rows
    .filter(r => !r.hidden)
    .map(r => [report.date, r.project, r.odooDescription, formatHHMM(r.minutes)]);
  return [header, ...body].map(cols => cols.map(csvCell).join(',')).join('\r\n');
}

/** "TEST-102#2" (a second hand-added entry) → "TEST-102". */
function baseKey(key: string): string {
  return key.replace(/#\d+$/, '');
}

/** Capitalised, ends with a full stop: "added sort" → "Added sort." */
function sentence(text: string): string {
  const t = capitalize(text.trim().replace(/[;,\s]+$/, ''));
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

/** True when the user changed something in the timesheet (an agent summary alone doesn't count). */
function isEditedByUser(o: RowOverride): boolean {
  return Object.keys(o).some(
    k =>
      !['hidden', 'added', 'descriptionBy', 'project', 'loggedMinutes'].includes(k) &&
      !(k === 'description' && o.descriptionBy),
  );
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function csvCell(value: string): string {
  // Titles come from Jira (written by others): stop Excel from running "=…", "+…", "@…" as formulas.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
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

export type TaskKind = 'jira' | 'branch' | 'general' | 'manual';

export interface TaskInfo {
  key: string;
  title: string;
  kind: TaskKind;
}

/** A continuous stretch of activity on one task, in one VS Code window. */
export interface Segment {
  taskKey: string;
  start: number;
  end: number;
  repo?: string;
  branch?: string;
}

export interface CommitRef {
  hash: string;
  message: string;
  time: number;
}

export interface Note {
  time: number;
  text: string;
}

/** Everything one window recorded on one day. Each window writes only its own file. */
export interface DayFile {
  version: 1;
  windowId: string;
  date: string;
  tasks: Record<string, TaskInfo>;
  segments: Segment[];
  commits: Record<string, CommitRef[]>;
  notes: Record<string, Note[]>;
}

/** Manual corrections made in the timesheet. Times are "HH:mm". */
export interface RowOverride {
  title?: string;
  start?: string;
  end?: string;
  minutes?: number;
  description?: string;
  /** Set when a coding agent wrote the description; cleared when you edit it. */
  descriptionBy?: 'agent';
  hidden?: boolean;
  /** Row created by hand in the timesheet, not from tracking. */
  added?: boolean;
}

export type DayOverrides = Record<string, RowOverride>;

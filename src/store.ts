import * as fs from 'fs';
import * as path from 'path';
import { dayKey } from './time';
import { CommitRef, DayFile, DayOverrides, ProjectMemory, Segment, TaskInfo } from './types';

/**
 * Plain JSON files in the extension's global storage, shared by all VS Code windows.
 *
 *   days/<date>/<windowId>.json   what each window tracked (only that window writes it)
 *   overrides/<date>.json         edits made in the timesheet
 *   titles.json                   task titles fetched from Jira
 *   projects.json                 Odoo projects chosen before (suggestions)
 *   branches.json                 branches to track, per repository
 */
export class Store {
  private readonly own = new Map<string, DayFile>();
  private readonly dirty = new Set<string>();

  constructor(readonly root: string, readonly windowId: string) {
    fs.mkdirSync(path.join(root, 'days'), { recursive: true });
    fs.mkdirSync(path.join(root, 'overrides'), { recursive: true });
  }

  addSegment(task: TaskInfo, start: number, where: { repo?: string; branch?: string }): Segment {
    const day = this.ownDay(dayKey(start));
    day.tasks[task.key] = task;
    const segment: Segment = { taskKey: task.key, start, end: start, ...where };
    day.segments.push(segment);
    this.touch(segment);
    return segment;
  }

  /** Mark the day holding this segment as needing a write. */
  touch(segment: Segment): void {
    this.dirty.add(dayKey(segment.start));
  }

  addCommit(task: TaskInfo, commit: CommitRef): void {
    const day = this.ownDay(dayKey(commit.time));
    day.tasks[task.key] ??= task;
    const list = (day.commits[task.key] ??= []);
    if (!list.some(c => c.hash === commit.hash || c.message === commit.message)) {
      list.push(commit);
      this.dirty.add(day.date);
    }
  }

  addNote(task: TaskInfo, text: string): void {
    const now = Date.now();
    const day = this.ownDay(dayKey(now));
    day.tasks[task.key] ??= task;
    (day.notes[task.key] ??= []).push({ time: now, text });
    this.dirty.add(day.date);
  }

  updateTaskTitle(key: string, title: string): void {
    for (const day of this.own.values()) {
      const task = day.tasks[key];
      if (task && task.title !== title) {
        task.title = title;
        this.dirty.add(day.date);
      }
    }
  }

  flush(): void {
    for (const date of this.dirty) {
      const day = this.own.get(date);
      if (day) {
        const dir = path.join(this.root, 'days', date);
        fs.mkdirSync(dir, { recursive: true });
        writeJson(path.join(dir, `${this.windowId}.json`), day);
      }
    }
    this.dirty.clear();
  }

  /** All windows' records for a day (this window's from memory, others from disk). */
  readDay(date: string): DayFile[] {
    const result: DayFile[] = [];
    const dir = path.join(this.root, 'days', date);
    const ownFile = `${this.windowId}.json`;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // No data for this day yet.
    }
    for (const name of names) {
      if (name.endsWith('.json') && name !== ownFile) {
        const file = readJson<DayFile>(path.join(dir, name));
        if (file?.segments) {
          result.push(file);
        }
      }
    }
    const mine = this.own.get(date);
    if (mine) {
      result.push(mine);
    }
    return result;
  }

  readOverrides(date: string): DayOverrides {
    return readJson<DayOverrides>(this.overridesPath(date)) ?? {};
  }

  writeOverrides(date: string, overrides: DayOverrides): void {
    writeJson(this.overridesPath(date), overrides);
  }

  getProjectMemory(): ProjectMemory {
    const memory = readJson<Partial<ProjectMemory>>(path.join(this.root, 'projects.json')) ?? {};
    return { byTask: memory.byTask ?? {}, byRepo: memory.byRepo ?? {}, recent: memory.recent ?? [] };
  }

  /** Remember the project for this task (and its repository) so it is suggested next time. */
  rememberProject(taskKey: string, repo: string | undefined, project: string): void {
    const memory = this.getProjectMemory();
    memory.byTask[taskKey] = project;
    if (repo) {
      memory.byRepo[repo] = project;
    }
    memory.recent = [project, ...memory.recent.filter(p => p !== project)].slice(0, 20);
    writeJson(path.join(this.root, 'projects.json'), memory);
  }

  isTrackedBranch(repoRoot: string, branch: string): boolean {
    return this.readTrackedBranches()[repoId(repoRoot)]?.includes(branch) ?? false;
  }

  addTrackedBranch(repoRoot: string, branch: string): void {
    const all = this.readTrackedBranches();
    const id = repoId(repoRoot);
    if (!all[id]?.includes(branch)) {
      all[id] = [...(all[id] ?? []), branch];
      writeJson(path.join(this.root, 'branches.json'), all);
    }
  }

  private readTrackedBranches(): Record<string, string[]> {
    return readJson<Record<string, string[]>>(path.join(this.root, 'branches.json')) ?? {};
  }

  getTitle(key: string): string | undefined {
    return this.readTitles()[key];
  }

  setTitle(key: string, title: string): void {
    const titles = this.readTitles();
    titles[key] = title;
    writeJson(path.join(this.root, 'titles.json'), titles);
  }

  private readTitles(): Record<string, string> {
    return readJson<Record<string, string>>(path.join(this.root, 'titles.json')) ?? {};
  }

  private overridesPath(date: string): string {
    return path.join(this.root, 'overrides', `${date}.json`);
  }

  private ownDay(date: string): DayFile {
    let day = this.own.get(date);
    if (!day) {
      day = { version: 1, windowId: this.windowId, date, tasks: {}, segments: [], commits: {}, notes: {} };
      this.own.set(date, day);
    }
    return day;
  }
}

/** Same repository, same id: Windows paths differ in drive-letter case between APIs. */
function repoId(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Write via a temp file so other windows never read a half-written file. */
function writeJson(file: string, data: unknown): void {
  const json = JSON.stringify(data, null, 1);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, json);
    fs.rmSync(tmp, { force: true });
  }
}

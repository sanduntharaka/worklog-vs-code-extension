import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { GitWatcher, NewCommit } from './git';
import { Jira } from './jira';
import { Store } from './store';
import { taskFromBranch, taskLabel } from './tasks';
import { dayKey, endOfDay, startOfDay } from './time';
import { Segment, TaskInfo } from './types';

const TICK_MS = 30_000;
// Agents rewrite files in the workspace; git's own housekeeping (auto-fetch etc.) is not activity.
const IGNORED_PATHS = /[\\/](\.git|node_modules)([\\/]|$)/;

export type TrackerState = 'tracking' | 'idle' | 'paused' | 'off';

/**
 * Decides which task this window is working on and records segments of activity for it.
 *
 * - Branch tasks count only while there is activity; after `idleMinutes` of silence the
 *   segment is closed at the last activity.
 * - Non-Jira (manual) tasks run from start to stop, because that work often happens
 *   outside VS Code (browser, meetings).
 */
export class Tracker implements vscode.Disposable {
  private paused = false;
  private manual: TaskInfo | undefined;
  private branchTask: TaskInfo | undefined;
  private where: { repo?: string; branch?: string } = {};
  private readonly confirmed = new Set<string>();
  private segment: Segment | undefined;
  private segmentTask: TaskInfo | undefined;
  private lastActivity = 0;
  private lastSignature = '';
  private readonly timer: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.emitter.event;

  constructor(private readonly store: Store, private readonly git: GitWatcher, private readonly jira: Jira) {
    const activity = () => this.markActivity();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFile = (uri: vscode.Uri) => {
      if (!IGNORED_PATHS.test(uri.fsPath)) {
        activity();
      }
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(onFile),
      watcher.onDidCreate(onFile),
      watcher.onDidDelete(onFile),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.contentChanges.length && (e.document.uri.scheme === 'file' || e.document.uri.scheme === 'untitled')) {
          activity();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(activity),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.refreshTask();
        activity();
      }),
      vscode.window.onDidChangeTextEditorSelection(activity),
      vscode.window.onDidChangeTextEditorVisibleRanges(activity),
      vscode.window.onDidChangeWindowState(s => {
        if (s.focused && s.active) {
          activity();
        }
      }),
      vscode.window.onDidOpenTerminal(activity),
      vscode.window.onDidChangeActiveTerminal(activity),
      vscode.window.onDidStartTerminalShellExecution(activity),
      vscode.window.onDidEndTerminalShellExecution(activity),
      git.onDidChangeBranch(() => this.refreshTask()),
      git.onDidCommit(c => this.onCommit(c)),
      jira.onDidResolveTitle(({ key, title }) => {
        this.store.updateTaskTitle(key, title);
        if (this.branchTask?.key === key) {
          this.branchTask.title = title;
        }
        this.changed(true);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workMonitor')) {
          this.refreshTask();
        }
      }),
    );
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.refreshTask();
    if (vscode.window.state.focused) {
      activity();
    }
    this.updateContext();
  }

  /** The task time is currently going to (or would go to, once there is activity). */
  get task(): TaskInfo | undefined {
    if (this.paused) {
      return undefined;
    }
    if (this.manual) {
      return this.manual;
    }
    const task = this.branchTask;
    if (task && !getConfig().autoStart && !this.confirmed.has(task.key)) {
      return undefined;
    }
    return task;
  }

  get state(): TrackerState {
    if (this.paused) {
      return 'paused';
    }
    if (!this.task) {
      return 'off';
    }
    return this.segment ? 'tracking' : 'idle';
  }

  get isManual(): boolean {
    return !!this.manual;
  }

  startManual(task: TaskInfo): void {
    this.manual = task;
    this.paused = false;
    this.sync(Date.now());
  }

  stopManual(): void {
    this.manual = undefined;
    this.sync(Date.now());
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.lastActivity = Date.now();
    }
    this.sync(Date.now());
  }

  addNote(text: string): boolean {
    const task = this.task ?? this.branchTask;
    if (!task) {
      return false;
    }
    this.store.addNote(task, text);
    this.store.flush();
    this.changed(true);
    return true;
  }

  private refreshTask(): void {
    const cfg = getConfig();
    const repo = this.git.currentRepo();
    const branch = repo?.state.HEAD?.name;
    const next = branch ? taskFromBranch(branch, cfg) : undefined;
    if (next?.kind === 'jira') {
      const known = this.store.getTitle(next.key);
      if (known) {
        next.title = known;
      } else {
        void this.jira.resolveTitle(next.key);
      }
    }
    const switched = next?.key !== this.branchTask?.key;
    this.branchTask = next;
    this.where = { repo: repo ? path.basename(repo.rootUri.fsPath) : undefined, branch };
    if (switched && next && !cfg.autoStart && !this.confirmed.has(next.key) && !this.manual && !this.paused) {
      void this.askToStart(next);
    }
    this.sync(Date.now());
  }

  private async askToStart(task: TaskInfo): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Track time for ${taskLabel(task)}${task.kind === 'jira' ? ` — ${task.title}` : ''}?`,
      'Start Tracking',
      'Not Now',
    );
    if (choice === 'Start Tracking') {
      this.confirmed.add(task.key);
      this.markActivity();
    }
  }

  private markActivity(): void {
    const now = Date.now();
    this.lastActivity = now;
    if (this.segment) {
      if (!this.isManualSegment()) {
        this.segment.end = now;
        this.store.touch(this.segment);
      }
    } else {
      this.sync(now);
    }
  }

  /** Make the open segment match the current task. */
  private sync(now: number): void {
    const task = this.task;
    if (this.segment && this.segmentTask?.key !== task?.key) {
      this.close(now);
    }
    if (!this.segment && task && (task === this.manual || now - this.lastActivity < getConfig().idleMs)) {
      this.open(task, now);
    }
    this.changed();
  }

  private tick(): void {
    const now = Date.now();
    // `active` = the user touched this window recently (also covers typing in webviews such as chat panels).
    const windowState = vscode.window.state;
    if (windowState.focused && windowState.active) {
      this.markActivity();
    }
    if (this.segment && this.segmentTask) {
      if (dayKey(this.segment.start) !== dayKey(now)) {
        this.splitAtMidnight(now);
      } else if (this.isManualSegment()) {
        this.segment.end = now;
        this.store.touch(this.segment);
      } else if (now - this.lastActivity > getConfig().idleMs) {
        this.close(this.lastActivity);
      }
    }
    this.store.flush();
    this.changed(true);
  }

  private splitAtMidnight(now: number): void {
    const segment = this.segment!;
    const task = this.segmentTask!;
    const manual = this.isManualSegment();
    this.close(Math.min(manual ? now : this.lastActivity, endOfDay(dayKey(segment.start))));
    if (manual || now - this.lastActivity < getConfig().idleMs) {
      this.open(task, startOfDay(dayKey(now)));
    }
  }

  private onCommit({ commit }: NewCommit): void {
    const cfg = getConfig();
    const firstLine = commit.message.split('\n')[0].trim();
    const keyInMessage = cfg.taskKeyPattern.exec(firstLine)?.[0];
    let task: TaskInfo | undefined = this.branchTask ?? this.task;
    if (keyInMessage && keyInMessage !== task?.key) {
      task = { key: keyInMessage, title: this.store.getTitle(keyInMessage) ?? keyInMessage, kind: 'jira' };
    }
    if (!task) {
      return;
    }
    const time = (commit.commitDate ?? commit.authorDate)?.getTime() ?? Date.now();
    this.store.addCommit(task, { hash: commit.hash, message: firstLine, time });
    this.markActivity();
    this.store.flush();
    this.changed(true);
  }

  private open(task: TaskInfo, at: number): void {
    const where = task === this.manual ? {} : this.where;
    this.segment = this.store.addSegment(task, at, where);
    this.segmentTask = task;
  }

  private close(at: number): void {
    if (!this.segment) {
      return;
    }
    this.segment.end = Math.max(this.segment.start, at);
    this.store.touch(this.segment);
    this.segment = undefined;
    this.segmentTask = undefined;
  }

  private isManualSegment(): boolean {
    return !!this.manual && this.segmentTask === this.manual;
  }

  /** Notify listeners; without `force`, only when the visible state actually changed. */
  private changed(force = false): void {
    const signature = `${this.state}|${this.task?.key}|${this.task?.title}|${this.paused}|${!!this.manual}`;
    if (!force && signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;
    this.updateContext();
    this.emitter.fire();
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'workMonitor.paused', this.paused);
    void vscode.commands.executeCommand('setContext', 'workMonitor.manual', !!this.manual);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.close(this.isManualSegment() ? Date.now() : this.lastActivity);
    this.store.flush();
    this.disposables.forEach(d => d.dispose());
    this.emitter.dispose();
  }
}

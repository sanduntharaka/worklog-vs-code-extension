import * as vscode from 'vscode';
import { getConfig } from './config';
import { buildDay, TaskRow } from './report';
import { Store } from './store';
import { formatDuration, today } from './time';
import { Tracker } from './tracker';

const ICONS: Record<TaskRow['kind'], string> = {
  jira: 'issues',
  manual: 'note',
  general: 'git-branch',
  branch: 'git-branch',
};

/** Sidebar list of today's tasks. */
export class TodayTree implements vscode.TreeDataProvider<TaskRow>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly view: vscode.TreeView<TaskRow>;
  private readonly sub: vscode.Disposable;

  constructor(private readonly tracker: Tracker, private readonly store: Store) {
    this.view = vscode.window.createTreeView('workMonitor.today', { treeDataProvider: this });
    this.sub = tracker.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(): TaskRow[] {
    const activeKey = this.tracker.state === 'tracking' ? this.tracker.task?.key : undefined;
    const report = buildDay(this.store, today(), activeKey, getConfig().roundToMinutes);
    this.view.description = report.rows.length ? formatDuration(report.totalMinutes) : undefined;
    return report.rows.filter(r => !r.hidden);
  }

  getTreeItem(row: TaskRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.kind === 'jira' ? `${row.key}  ${row.title}` : row.title);
    item.description = `${formatDuration(row.minutes)} · ${row.start}–${row.end}`;
    item.iconPath = row.active
      ? new vscode.ThemeIcon('record', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon(ICONS[row.kind] ?? 'circle-outline');
    item.contextValue = row.kind === 'jira' ? 'jiraTask' : 'task';
    // Titles and descriptions come from Jira, commits and agents: plain text, never markdown.
    const tip = new vscode.MarkdownString();
    tip.appendText(`${row.kind === 'jira' ? `${row.key} — ` : ''}${row.title}`);
    tip.appendMarkdown('\n\n');
    tip.appendText(`${row.start}–${row.end} · ${formatDuration(row.minutes)}${row.active ? ' · tracking now' : ''}`);
    if (row.description) {
      tip.appendMarkdown('\n\n');
      tip.appendText(row.description);
    }
    item.tooltip = tip;
    item.command = { command: 'workMonitor.openTimesheet', title: 'Open Timesheet' };
    return item;
  }

  dispose(): void {
    this.sub.dispose();
    this.view.dispose();
    this.emitter.dispose();
  }
}

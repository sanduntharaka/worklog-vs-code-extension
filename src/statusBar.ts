import * as vscode from 'vscode';
import { getConfig } from './config';
import { buildDay } from './report';
import { Store } from './store';
import { taskLabel } from './tasks';
import { formatDuration, today } from './time';
import { Tracker } from './tracker';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('workMonitor.status', vscode.StatusBarAlignment.Left, 100);
  private readonly sub: vscode.Disposable;

  constructor(private readonly tracker: Tracker, private readonly store: Store) {
    this.item.name = 'Work Monitor';
    this.item.command = 'workMonitor.statusMenu';
    this.sub = tracker.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  update(): void {
    const task = this.tracker.task;
    const state = this.tracker.state;
    const report = buildDay(this.store, today(), task?.key, getConfig().roundToMinutes);
    const row = task && report.rows.find(r => r.key === task.key);
    const spent = formatDuration(row?.trackedMinutes ?? 0);

    const tip = new vscode.MarkdownString('', true);
    if (state === 'paused') {
      this.item.text = '$(debug-pause) Paused';
      tip.appendMarkdown('**Tracking paused.** Click to resume.');
    } else if (!task) {
      this.item.text = '$(clock) Not tracking';
      tip.appendMarkdown('No task detected. Check out a task branch or start a non-Jira task.');
    } else {
      const icon = state === 'tracking' ? '$(record)' : '$(clock)';
      this.item.text = `${icon} ${taskLabel(task)} · ${spent}${state === 'idle' ? ' (idle)' : ''}`;
      // Titles come from Jira / branch names: append as plain text, never as markdown.
      tip.appendText(`${taskLabel(task)}${task.kind === 'jira' ? ` — ${task.title}` : ''}`);
      tip.appendMarkdown(`\n\n${spent} today${state === 'idle' ? ' · idle, resumes on activity' : ''}`);
    }
    tip.appendMarkdown(`\n\n---\n\nToday total: **${formatDuration(report.totalMinutes)}**`);
    this.item.tooltip = tip;
    this.item.backgroundColor =
      state === 'paused' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}

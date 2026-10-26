import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { Jira } from './jira';
import { buildDay, rowToText, toCsv, toText } from './report';
import { Store } from './store';
import { taskFromText } from './tasks';
import { addDays, today } from './time';
import { Tracker } from './tracker';
import { RowOverride } from './types';

type Inbound =
  | { type: 'ready' }
  | { type: 'nav'; delta?: number; today?: boolean }
  | { type: 'edit'; key: string; field: keyof RowOverride; value: string | number }
  | { type: 'reset' | 'hide' | 'unhide' | 'copyRow' | 'openJira'; key: string }
  | { type: 'copyText'; text: string }
  | { type: 'copyAll' | 'exportCsv' | 'addEntry' };

const EDITABLE = new Set<keyof RowOverride>(['title', 'start', 'end', 'minutes', 'description']);

function isValidEdit(field: keyof RowOverride, value: unknown): boolean {
  switch (field) {
    case 'minutes':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 24 * 60;
    case 'start':
    case 'end':
      return typeof value === 'string' && /^(\d{2}:\d{2})?$/.test(value);
    default:
      return typeof value === 'string' && value.length <= 5000;
  }
}

/** The daily timesheet: one editable card per task, ready to copy into Odoo. */
export class TimesheetPanel implements vscode.Disposable {
  private static current: TimesheetPanel | undefined;

  private date = today();
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, store: Store, tracker: Tracker, jira: Jira): void {
    if (this.current) {
      this.current.date = today();
      this.current.panel.reveal();
      this.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel('workMonitor.timesheet', 'Timesheet', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.current = new TimesheetPanel(panel, extensionUri, store, tracker, jira);
  }

  static refresh(): void {
    this.current?.render();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly tracker: Tracker,
    private readonly jira: Jira,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');
    panel.webview.html = this.html(panel.webview, extensionUri);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(() => this.render()),
      panel.webview.onDidReceiveMessage((m: Inbound) => this.onMessage(m)),
      tracker.onDidChange(() => this.render()),
    );
  }

  private report(activeKey?: string) {
    return buildDay(this.store, this.date, activeKey, getConfig().roundToMinutes);
  }

  private render(): void {
    if (!this.panel.visible) {
      return;
    }
    const activeKey = this.date === today() && this.tracker.state === 'tracking' ? this.tracker.task?.key : undefined;
    const report = this.report(activeKey);
    void this.panel.webview.postMessage({
      type: 'render',
      report,
      isToday: this.date === today(),
      jira: !!getConfig().jiraBaseUrl,
    });
  }

  private async onMessage(m: Inbound): Promise<void> {
    switch (m.type) {
      case 'ready':
        break;
      case 'nav':
        this.date = m.today ? today() : addDays(this.date, Math.sign(Number(m.delta) || 0));
        break;
      case 'edit':
        if (!EDITABLE.has(m.field) || !isValidEdit(m.field, m.value)) {
          return;
        }
        this.updateOverride(m.key, o => {
          (o as Record<string, unknown>)[m.field] = m.value;
          if (m.field === 'description') {
            delete o.descriptionBy;
          }
        });
        break;
      case 'reset':
        this.updateOverride(m.key, o => (o.added ? null : {}));
        break;
      case 'hide':
      case 'unhide':
        this.updateOverride(m.key, o => {
          o.hidden = m.type === 'hide';
        });
        break;
      case 'copyRow': {
        const row = this.report().rows.find(r => r.key === m.key);
        if (row) {
          await this.copy(rowToText(row), 'Task copied');
        }
        return;
      }
      case 'copyText':
        await this.copy(m.text, 'Copied');
        return;
      case 'copyAll':
        await this.copy(toText(this.report()), 'Timesheet copied');
        return;
      case 'exportCsv':
        await this.exportCsv();
        return;
      case 'addEntry':
        await this.addEntry();
        break;
      case 'openJira': {
        const url = this.jira.browseUrl(m.key.replace(/#\d+$/, ''));
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          await vscode.commands.executeCommand('workMonitor.connectJira');
        }
        return;
      }
    }
    this.render();
  }

  /** Apply a change to one row's override. Return null from `change` to delete the row's override. */
  private updateOverride(key: string, change: (o: RowOverride) => RowOverride | null | void): void {
    const all = this.store.readOverrides(this.date);
    const current = { ...(all[key] ?? {}) };
    const result = change(current);
    if (result === null) {
      delete all[key];
    } else {
      const next = result ?? current;
      if (current.added) {
        next.added = true;
      }
      all[key] = next;
    }
    this.store.writeOverrides(this.date, all);
  }

  private async addEntry(): Promise<void> {
    const text = await vscode.window.showInputBox({
      title: 'Add timesheet entry',
      prompt: 'What did you work on? Start with a Jira key to link it, e.g. "TEST-102 Code review".',
      placeHolder: 'Team meeting',
    });
    if (!text?.trim()) {
      return;
    }
    const task = taskFromText(text, getConfig());
    const all = this.store.readOverrides(this.date);
    let key = task.key;
    for (let i = 2; all[key] || this.report().rows.some(r => r.key === key); i++) {
      key = `${task.key}#${i}`;
    }
    all[key] = { added: true, title: task.title, start: '', end: '', minutes: 30, description: '' };
    this.store.writeOverrides(this.date, all);
  }

  private async exportCsv(): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `timesheet-${this.date}.csv`)),
      filters: { CSV: ['csv'] },
    });
    if (!target) {
      return;
    }
    // BOM so Excel opens accented characters correctly.
    fs.writeFileSync(target.fsPath, '﻿' + toCsv(this.report()));
    const open = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`, 'Open');
    if (open) {
      await vscode.env.openExternal(target);
    }
  }

  private async copy(text: string, message: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    void this.panel.webview.postMessage({ type: 'toast', text: message });
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('timesheet.css')}">
<title>Timesheet</title>
</head>
<body>
<div id="app"></div>
<div id="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${media('timesheet.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    TimesheetPanel.current = undefined;
    this.disposables.forEach(d => d.dispose());
    this.panel.dispose();
  }
}

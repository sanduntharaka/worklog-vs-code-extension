import * as vscode from 'vscode';

export interface Config {
  taskKeyPattern: RegExp;
  generalBranches: string[];
  trackGeneralBranches: boolean;
  autoStart: boolean;
  idleMs: number;
  manualTaskPresets: string[];
  reminderTime: string;
  roundToMinutes: number;
  jiraBaseUrl: string;
}

/**
 * The Jira site from *user* settings only, and only over https. Your API token is sent to this
 * URL, so a repository's .vscode/settings.json must never be able to change it.
 */
function userJiraBaseUrl(c: vscode.WorkspaceConfiguration): string {
  const value = (c.inspect<string>('jira.baseUrl')?.globalValue ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/?#]+/i.test(value) ? value : '';
}

export function getConfig(): Config {
  const c = vscode.workspace.getConfiguration('workMonitor');
  let pattern: RegExp;
  try {
    pattern = new RegExp(c.get<string>('taskKeyPattern', '[A-Z][A-Z0-9]+-\\d+'));
  } catch {
    pattern = /[A-Z][A-Z0-9]+-\d+/;
  }
  return {
    taskKeyPattern: pattern,
    generalBranches: c.get<string[]>('generalBranches', ['main', 'master', 'develop']),
    trackGeneralBranches: c.get<boolean>('trackGeneralBranches', true),
    autoStart: c.get<boolean>('autoStart', true),
    idleMs: Math.max(1, c.get<number>('idleMinutes', 10)) * 60_000,
    manualTaskPresets: c.get<string[]>('manualTaskPresets', []),
    reminderTime: c.get<string>('reminderTime', '17:30'),
    roundToMinutes: c.get<number>('roundToMinutes', 0),
    jiraBaseUrl: userJiraBaseUrl(c),
  };
}

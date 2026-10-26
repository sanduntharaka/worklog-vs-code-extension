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
    jiraBaseUrl: c.get<string>('jira.baseUrl', '').trim().replace(/\/+$/, ''),
  };
}

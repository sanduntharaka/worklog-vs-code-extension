import type { Config } from './config';
import { TaskInfo } from './types';

export const GENERAL_TASK: TaskInfo = { key: 'general', title: 'General (no task branch)', kind: 'general' };

/**
 * issue/TEST-101-add-date-filter-to-orders-list
 *   → { key: 'TEST-101', title: 'Add date filter to orders list', kind: 'jira' }
 */
export function taskFromBranch(branch: string, cfg: Config): TaskInfo | undefined {
  const leaf = branch.split('/').pop() ?? branch;
  if (cfg.generalBranches.includes(branch) || cfg.generalBranches.includes(leaf)) {
    return cfg.trackGeneralBranches ? GENERAL_TASK : undefined;
  }
  const match = cfg.taskKeyPattern.exec(branch);
  if (match) {
    const key = match[0];
    const slug = branch.slice(match.index + key.length);
    return { key, title: slugToTitle(slug) || key, kind: 'jira' };
  }
  return { key: `branch:${branch}`, title: branch, kind: 'branch' };
}

/** "Check issues" → manual task; "TEST-102 code review" → that Jira task. */
export function taskFromText(text: string, cfg: Config): TaskInfo {
  const title = text.trim();
  const match = cfg.taskKeyPattern.exec(title);
  if (match && match.index === 0) {
    const rest = title.slice(match[0].length).replace(/^[\s:\-–]+/, '');
    return { key: match[0], title: rest || match[0], kind: 'jira' };
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { key: `manual:${slug || Date.now()}`, title, kind: 'manual' };
}

/** A short label for lists and the status bar. */
export function taskLabel(task: Pick<TaskInfo, 'key' | 'title' | 'kind'>): string {
  return task.kind === 'jira' ? task.key : task.title;
}

/** Commit message without the leading task key: "TEST-101: fix sort" → "fix sort". */
export function stripKey(message: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return message.replace(new RegExp(`^\\s*\\[?${escaped}\\]?[\\s:\\-–]*`, 'i'), '').trim();
}

function slugToTitle(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

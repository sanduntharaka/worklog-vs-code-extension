/**
 * Work Monitor MCP server (stdio, newline-delimited JSON-RPC).
 *
 * Lets a coding agent read and write the timesheet description of the task it is working on.
 * Runs as a plain Node process (no `vscode` module). The extension copies this file and its
 * dependencies into `<globalStorage>/agent/` so the registered path survives extension updates;
 * the storage root is therefore the parent folder, unless `--storage <dir>` is given.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { buildDay, TaskRow } from './report';
import { Store } from './store';
import { taskFromBranch } from './tasks';
import { formatDuration, today } from './time';
import { TaskInfo } from './types';

const VERSION = '0.2.1';
const MAX_SUMMARY = 1000;

interface AgentSettings {
  taskKeyPattern?: string;
  generalBranches?: string[];
}

const storageArg = process.argv.indexOf('--storage');
const root = storageArg > 0 ? process.argv[storageArg + 1] : path.resolve(__dirname, '..');
const store = new Store(root, 'agent');

const TARGET_PROPS = {
  taskKey: {
    type: 'string',
    description: 'Jira key such as "TEST-101". Omit to use the task of the current git branch.',
  },
  cwd: {
    type: 'string',
    description: 'Absolute path of the repository you are working in. Omit to use the session working directory.',
  },
};

const TOOLS = [
  {
    name: 'get_work_summary',
    description:
      "Read today's Work Monitor timesheet entry for the current task: title, time tracked, the current " +
      'description, and the commits and notes recorded today. Always call this before set_work_summary.',
    inputSchema: { type: 'object', properties: TARGET_PROPS },
  },
  {
    name: 'set_work_summary',
    description:
      "Replace today's timesheet description for the current task with one clean summary. " +
      'The summary must MERGE what the current description already says with the work done in this ' +
      'conversation: keep points that are still true, drop duplicates and superseded details, add the new work. ' +
      'Style: a short line per piece of work, joined with "; ", past tense, outcome-focused, plain words a ' +
      'manager understands, no task key, no file paths unless essential, no filler. Usually under 300 characters.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The merged summary.' },
        ...TARGET_PROPS,
      },
      required: ['summary'],
    },
  },
];

const INSTRUCTIONS =
  'Work Monitor keeps the user\'s daily timesheet. When the user asks to update the work description, ' +
  'work log or timesheet, call get_work_summary, then set_work_summary with a merged summary.';

// ---- tools ------------------------------------------------------------------

function resolveTask(args: { taskKey?: string; cwd?: string }): { task: TaskInfo; branch?: string } {
  const settings = readSettings();
  const cfg = {
    taskKeyPattern: safeRegex(settings.taskKeyPattern),
    generalBranches: settings.generalBranches ?? ['main', 'master', 'develop', 'dev', 'staging'],
    trackGeneralBranches: true,
  };
  if (args.taskKey) {
    const raw = args.taskKey.trim();
    const manual = raw.startsWith('manual:');
    const key = manual ? raw : raw.toUpperCase();
    // Only real task keys: this becomes a key in the timesheet files.
    if (!(manual ? /^manual:[a-z0-9-]{1,80}$/ : /^[A-Z][A-Z0-9]{0,19}-\d{1,9}$/).test(key)) {
      throw new Error(`"${raw.slice(0, 40)}" is not a valid task key (expected something like "TEST-101").`);
    }
    return { task: { key, title: store.getTitle(key) ?? findRow(key)?.title ?? key, kind: manual ? 'manual' : 'jira' } };
  }
  const cwd = args.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let branch: string;
  try {
    // Unlike `rev-parse HEAD`, this also works on a new branch that has no commits yet.
    branch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`"${cwd}" is not a git repository. Pass taskKey (e.g. "TEST-101") or cwd.${todayList()}`);
  }
  if (!branch) {
    throw new Error(`"${cwd}" is in detached HEAD state. Pass taskKey (e.g. "TEST-101").${todayList()}`);
  }
  const task = taskFromBranch(branch, cfg as Parameters<typeof taskFromBranch>[1]);
  if (!task || task.kind !== 'jira') {
    throw new Error(`Branch "${branch}" has no task key. Ask the user which task this was and pass taskKey.${todayList()}`);
  }
  task.title = store.getTitle(task.key) ?? task.title;
  return { task, branch };
}

function getWorkSummary(args: { taskKey?: string; cwd?: string }): string {
  const { task, branch } = resolveTask(args);
  const row = findRow(task.key);
  const lines = [`Task: ${task.key} — ${row?.title ?? task.title}`];
  if (branch) {
    lines.push(`Branch: ${branch}`);
  }
  if (row) {
    lines.push(`Today: ${row.start}–${row.end}, ${formatDuration(row.trackedMinutes)} tracked`);
    lines.push('', `Current description${row.summaryByAgent ? ' (written by an agent earlier)' : row.edited ? ' (edited by the user — keep its points)' : ''}:`);
    lines.push(row.description || '(empty)');
    if (row.commits.length) {
      lines.push('', 'Commits today:', ...row.commits.map(c => `- ${c}`));
    }
    if (row.notes.length) {
      lines.push('', 'Notes today:', ...row.notes.map(n => `- ${n}`));
    }
  } else {
    lines.push('', 'Nothing recorded for this task today yet. Current description: (empty)');
  }
  return lines.join('\n');
}

function setWorkSummary(args: { summary?: string; taskKey?: string; cwd?: string }): string {
  const summary = (args.summary ?? '')
    .replace(/\s*;?\s*\n\s*/g, '; ')
    .replace(/(;\s*)+/g, '; ')
    .replace(/^[;\s]+|[;\s]+$/g, '');
  if (!summary) {
    throw new Error('summary is empty.');
  }
  if (summary.length > MAX_SUMMARY) {
    throw new Error(`summary is too long (${summary.length} characters, max ${MAX_SUMMARY}). Make it shorter.`);
  }
  const { task } = resolveTask(args);
  const date = today();
  const overrides = store.readOverrides(date);
  const existing = overrides[task.key] ?? {};
  overrides[task.key] = {
    ...existing,
    description: summary,
    descriptionBy: 'agent',
    // No tracked time yet today: create the row so the summary shows up in the timesheet.
    ...(findRow(task.key) ? {} : { added: true, title: existing.title ?? task.title }),
  };
  store.writeOverrides(date, overrides);
  return `Saved the timesheet description for ${task.key}:\n${summary}`;
}

function findRow(key: string): TaskRow | undefined {
  return buildDay(store, today()).rows.find(r => r.key === key);
}

function todayList(): string {
  const keys = buildDay(store, today())
    .rows.filter(r => r.kind === 'jira')
    .map(r => `${r.key} (${r.title})`);
  return keys.length ? ` Tasks tracked today: ${keys.join(', ')}.` : '';
}

function readSettings(): AgentSettings {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'agent', 'settings.json'), 'utf8')) as AgentSettings;
  } catch {
    return {};
  }
}

function safeRegex(source?: string): RegExp {
  try {
    return new RegExp(source ?? '[A-Z][A-Z0-9]+-\\d+');
  } catch {
    return /[A-Z][A-Z0-9]+-\d+/;
  }
}

// ---- JSON-RPC over stdio ----------------------------------------------------

interface Request {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function send(message: object): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function handle(req: Request): void {
  const { id, method, params } = req;
  if (id === undefined) {
    return; // Notification (e.g. notifications/initialized): no reply.
  }
  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'work-monitor', version: VERSION },
          instructions: INSTRUCTIONS,
        },
      });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: TOOLS } });
    case 'tools/call': {
      const name = params?.name as string;
      const args = (params?.arguments ?? {}) as Record<string, string>;
      try {
        const text =
          name === 'get_work_summary' ? getWorkSummary(args)
          : name === 'set_work_summary' ? setWorkSummary(args)
          : undefined;
        if (text === undefined) {
          return send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        }
        return send({ id, result: { content: [{ type: 'text', text }] } });
      } catch (e) {
        return send({ id, result: { content: [{ type: 'text', text: (e as Error).message }], isError: true } });
      }
    }
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) {
    return;
  }
  try {
    handle(JSON.parse(line) as Request);
  } catch (e) {
    process.stderr.write(`work-monitor: bad message: ${(e as Error).message}\n`);
  }
});

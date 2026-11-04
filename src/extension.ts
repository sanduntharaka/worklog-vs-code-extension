import * as vscode from 'vscode';
import { connectAgent, installAgentServer } from './agent';
import { getConfig } from './config';
import { GitWatcher } from './git';
import { Jira } from './jira';
import { StatusBar } from './statusBar';
import { Store } from './store';
import { taskBranchName, taskFromText, taskLabel } from './tasks';
import { buildDay } from './report';
import { dayKey, formatHHMM, hhmm, today } from './time';
import { TimesheetPanel } from './timesheet';
import { Tracker } from './tracker';
import { TodayTree } from './tree';
import { TaskInfo } from './types';

const RECENT_MANUAL_KEY = 'workMonitor.recentManual';
const LAST_REMINDER_KEY = 'workMonitor.lastReminder';
const LAST_PROGRESS_KEY = 'workMonitor.lastProgressReminder';

let tracker: Tracker | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const windowId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const store = new Store(context.globalStorageUri.fsPath, windowId);
  const git = new GitWatcher();
  await git.init();
  const jira = new Jira(context.secrets, store);
  tracker = new Tracker(store, git, jira);
  const t = tracker;
  const status = new StatusBar(t, store);
  const tree = new TodayTree(t, store);

  const openTimesheet = () => TimesheetPanel.show(context.extensionUri, store, t, jira);
  const refreshAll = () => {
    status.update();
    tree.refresh();
    TimesheetPanel.refresh();
  };

  let agentServer = installAgentServer(context);
  // Agents (and other windows) write overrides directly; show their changes right away.
  const overridesWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.globalStorageUri, 'overrides/*.json'),
  );
  let refreshTimer: NodeJS.Timeout | undefined;
  const refreshSoon = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshAll, 200);
  };

  context.subscriptions.push(
    overridesWatcher,
    overridesWatcher.onDidChange(refreshSoon),
    overridesWatcher.onDidCreate(refreshSoon),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workMonitor.taskKeyPattern') || e.affectsConfiguration('workMonitor.generalBranches')) {
        agentServer = installAgentServer(context);
      }
    }),
    vscode.commands.registerCommand('workMonitor.connectAgent', () => connectAgent(agentServer)),
    git,
    jira,
    t,
    status,
    tree,
    vscode.commands.registerCommand('workMonitor.openTimesheet', openTimesheet),
    vscode.commands.registerCommand('workMonitor.createTaskBranch', () => createTaskBranch(git, t, store, jira)),
    vscode.commands.registerCommand('workMonitor.trackBranch', () => {
      const repo = git.currentRepo();
      const branch = t.trackableBranch;
      if (repo && branch) {
        t.trackBranch(repo, branch);
      }
    }),
    vscode.commands.registerCommand('workMonitor.startManualTask', () => startManualTask(context, t)),
    vscode.commands.registerCommand('workMonitor.stopManualTask', () => t.stopManual()),
    vscode.commands.registerCommand('workMonitor.pause', () => t.setPaused(true)),
    vscode.commands.registerCommand('workMonitor.resume', () => t.setPaused(false)),
    vscode.commands.registerCommand('workMonitor.addNote', () => addNote(t)),
    vscode.commands.registerCommand('workMonitor.refresh', refreshAll),
    vscode.commands.registerCommand('workMonitor.connectJira', async () => {
      await jira.connect();
      const task = t.task;
      if (task?.kind === 'jira') {
        await jira.resolveTitle(task.key);
      }
    }),
    vscode.commands.registerCommand('workMonitor.openInJira', async (row?: { key: string }) => {
      const key = row?.key ?? t.task?.key;
      const url = key && jira.browseUrl(key);
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        await vscode.commands.executeCommand('workMonitor.connectJira');
      }
    }),
    vscode.commands.registerCommand('workMonitor.statusMenu', () => statusMenu(t, jira)),
    vscode.commands.registerCommand('workMonitor.openDataFolder', () =>
      vscode.env.openExternal(context.globalStorageUri),
    ),
    startReminders(context, store, t, openTimesheet),
  );
}

export function deactivate(): void {
  // Close the open segment and write it before the window goes away.
  tracker?.dispose();
  tracker = undefined;
}

/** Ask for the task ID and name, then create (or reuse) issue/<ID>-<name> and track it. */
async function createTaskBranch(git: GitWatcher, tracker: Tracker, store: Store, jira: Jira): Promise<void> {
  const repo = git.currentRepo();
  if (!repo) {
    vscode.window.showWarningMessage('Open a folder that is a git repository to create a task branch.');
    return;
  }
  const keyPattern = new RegExp(`^(?:${getConfig().taskKeyPattern.source})$`);
  const input = await vscode.window.showInputBox({
    title: 'Create task branch (1/2)',
    prompt: 'Task ID',
    placeHolder: 'TEST-101',
    ignoreFocusOut: true,
    validateInput: v => (keyPattern.test(v.trim().toUpperCase()) ? undefined : 'Enter a task ID such as TEST-101'),
  });
  if (!input) {
    return;
  }
  const key = input.trim().toUpperCase();

  const knownTitle =
    store.getTitle(key) ??
    (await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Looking up ${key} in Jira` },
      () => jira.fetchTitle(key),
    ));
  const name = await vscode.window.showInputBox({
    title: 'Create task branch (2/2)',
    prompt: `Task name. The branch starts from ${repo.state.HEAD?.name ?? 'the current commit'}.`,
    value: knownTitle,
    placeHolder: 'Add date filter to orders list',
    ignoreFocusOut: true,
    validateInput: v =>
      v.trim()
        ? { message: `Branch: ${taskBranchName(key, v)}`, severity: vscode.InputBoxValidationSeverity.Info }
        : 'Enter the task name',
  });
  if (!name?.trim()) {
    return;
  }

  const branch = taskBranchName(key, name);
  try {
    const exists = await repo.getBranch(branch).then(
      () => true,
      () => false,
    );
    if (exists) {
      await repo.checkout(branch);
    } else {
      await repo.createBranch(branch, true);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Could not switch to ${branch}: ${(e as Error).message}`);
    return;
  }
  store.setTitle(key, name.trim());
  tracker.trackBranch(repo, branch);
  vscode.window.setStatusBarMessage(`$(git-branch) On ${branch} — tracking ${key}`, 4000);
}

async function startManualTask(context: vscode.ExtensionContext, tracker: Tracker): Promise<void> {
  const cfg = getConfig();
  const recent = context.globalState.get<string[]>(RECENT_MANUAL_KEY, []);
  const choices = [...new Set([...recent, ...cfg.manualTaskPresets])];

  const pick = vscode.window.createQuickPick();
  pick.title = 'Start a non-Jira task';
  pick.placeholder = 'Pick one or type a new task (start with a Jira key to link it, e.g. "TEST-102 Code review")';
  pick.items = choices.map(label => ({ label, iconPath: new vscode.ThemeIcon(recent.includes(label) ? 'history' : 'note') }));
  pick.onDidChangeValue(value => {
    const typed = value.trim();
    const exists = choices.some(c => c.toLowerCase() === typed.toLowerCase());
    pick.items = [
      ...(typed && !exists ? [{ label: typed, description: 'new task', iconPath: new vscode.ThemeIcon('add') }] : []),
      ...choices.map(label => ({ label, iconPath: new vscode.ThemeIcon(recent.includes(label) ? 'history' : 'note') })),
    ];
  });

  const text = await new Promise<string | undefined>(resolve => {
    pick.onDidAccept(() => resolve(pick.selectedItems[0]?.label ?? pick.value));
    pick.onDidHide(() => resolve(undefined));
    pick.show();
  });
  pick.dispose();
  if (!text?.trim()) {
    return;
  }

  const task: TaskInfo = taskFromText(text, cfg);
  tracker.startManual(task);
  await context.globalState.update(RECENT_MANUAL_KEY, [text.trim(), ...recent.filter(r => r !== text.trim())].slice(0, 8));
  vscode.window.setStatusBarMessage(`$(record) Tracking "${taskLabel(task)}" — stop it from the status bar`, 4000);
}

async function addNote(tracker: Tracker): Promise<void> {
  const task = tracker.task;
  const text = await vscode.window.showInputBox({
    title: task ? `Note for ${taskLabel(task)}` : 'Add note',
    prompt: 'A short line for the timesheet description',
    placeHolder: 'Discussed sorting rules with the backend team',
  });
  if (text?.trim() && !tracker.addNote(text.trim())) {
    vscode.window.showWarningMessage('No current task to attach the note to.');
  }
}

async function statusMenu(tracker: Tracker, jira: Jira): Promise<void> {
  const task = tracker.task;
  type Item = vscode.QuickPickItem & { run?: () => unknown };
  const items: Item[] = [];

  if (task) {
    items.push({ label: taskLabel(task), description: task.kind === 'jira' ? task.title : undefined, kind: vscode.QuickPickItemKind.Separator });
  }
  items.push({ label: '$(table) Open Timesheet', run: () => vscode.commands.executeCommand('workMonitor.openTimesheet') });
  items.push({ label: '$(git-branch) Create Task Branch…', description: 'issue/<ID>-<task-name>', run: () => vscode.commands.executeCommand('workMonitor.createTaskBranch') });
  if (tracker.trackableBranch) {
    items.push({ label: '$(eye) Track This Branch', description: tracker.trackableBranch, run: () => vscode.commands.executeCommand('workMonitor.trackBranch') });
  }
  if (tracker.isManual) {
    items.push({ label: '$(debug-stop) Stop Non-Jira Task', description: task?.title, run: () => tracker.stopManual() });
  }
  items.push({ label: '$(add) Start Non-Jira Task…', description: 'Check issues, docs, meetings…', run: () => vscode.commands.executeCommand('workMonitor.startManualTask') });
  if (task) {
    items.push({ label: '$(comment) Add Note…', run: () => vscode.commands.executeCommand('workMonitor.addNote') });
  }
  if (task?.kind === 'jira' && jira.browseUrl(task.key)) {
    items.push({ label: '$(link-external) Open in Jira', description: task.key, run: () => vscode.commands.executeCommand('workMonitor.openInJira') });
  }
  items.push(
    tracker.state === 'paused'
      ? { label: '$(debug-start) Resume Tracking', run: () => tracker.setPaused(false) }
      : { label: '$(debug-pause) Pause Tracking', description: 'Lunch, break…', run: () => tracker.setPaused(true) },
  );

  const choice = await vscode.window.showQuickPick(items, { title: 'Work Monitor' });
  await choice?.run?.();
}

/**
 * The Odoo procedure asks for timesheets to be updated several times a day, so remind:
 * - when you move to another task and the previous one has unlogged time,
 * - every `progressReminderHours` while time is unlogged,
 * - once at `reminderTime` for the final check.
 * globalState is shared by all windows, so only one window shows each timed reminder.
 */
function startReminders(
  context: vscode.ExtensionContext,
  store: Store,
  tracker: Tracker,
  openTimesheet: () => void,
): vscode.Disposable {
  const MIN_TO_REMIND = 15;
  const report = () => buildDay(store, today(), undefined, getConfig().roundToMinutes);
  const notify = async (message: string) => {
    const choice = await vscode.window.showInformationMessage(message, 'Open Timesheet', 'Later');
    if (choice === 'Open Timesheet') {
      openTimesheet();
    }
  };

  const lastSwitchReminder = new Map<string, number>();
  const onSwitch = tracker.onDidSwitchTask(key => {
    if (!getConfig().remindOnTaskSwitch || Date.now() - (lastSwitchReminder.get(key) ?? 0) < 30 * 60_000) {
      return;
    }
    const row = report().rows.find(r => r.key === key && !r.hidden);
    if (row && row.toLogMinutes >= MIN_TO_REMIND) {
      lastSwitchReminder.set(key, Date.now());
      void notify(`${row.label}: ${formatHHMM(row.toLogMinutes)} not logged in Odoo yet. Log it now while it's fresh?`);
    }
  });

  const check = async () => {
    const cfg = getConfig();
    const now = Date.now();

    if (cfg.reminderTime && hhmm(now) >= cfg.reminderTime && context.globalState.get(LAST_REMINDER_KEY) !== today()) {
      await context.globalState.update(LAST_REMINDER_KEY, today());
      const r = report();
      const failing = r.checks.filter(c => !c.ok);
      void notify(
        failing.length
          ? `Final timesheet check: ${failing.map(c => c.detail ?? c.label).join(', ')}.`
          : 'Final timesheet check: everything is logged and ready. ✓',
      );
      return;
    }

    if (cfg.progressReminderMs > 0) {
      const last = context.globalState.get<number>(LAST_PROGRESS_KEY, 0);
      if (dayKey(last) !== today()) {
        // First check of the day starts the clock.
        await context.globalState.update(LAST_PROGRESS_KEY, now);
      } else if (now - last >= cfg.progressReminderMs) {
        await context.globalState.update(LAST_PROGRESS_KEY, now);
        const toLog = report().toLogMinutes;
        if (toLog >= MIN_TO_REMIND) {
          void notify(`${formatHHMM(toLog)} of today's work isn't in Odoo yet. Update your timesheet?`);
        }
      }
    }
  };
  const timer = setInterval(check, 60_000);
  return new vscode.Disposable(() => {
    clearInterval(timer);
    onSwitch.dispose();
  });
}

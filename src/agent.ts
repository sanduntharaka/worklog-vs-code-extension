import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// The MCP server and the plain-Node modules it imports (none of them touch `vscode`).
const SERVER_FILES = ['mcp.js', 'report.js', 'store.js', 'tasks.js', 'time.js', 'types.js'];
const SERVER_NAME = 'work-monitor';

const WORKLOG_COMMAND = `---
description: Update today's Work Monitor timesheet description for the current task
argument-hint: [optional extra details or task key]
---
Update my Work Monitor timesheet description for the task we are working on.

1. Call the \`get_work_summary\` tool (work-monitor MCP server) to read the current description, commits and notes.
2. Write one clean summary that merges the existing description with what we did in this conversation, and save it with \`set_work_summary\`.
3. Reply with the saved summary in one line.

$ARGUMENTS
`;

/**
 * Copy the MCP server into global storage so the path registered with agents stays the same
 * across extension updates, and share the settings it needs.
 */
export function installAgentServer(context: vscode.ExtensionContext): string {
  const dir = path.join(context.globalStorageUri.fsPath, 'agent');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of SERVER_FILES) {
    fs.copyFileSync(path.join(context.extensionPath, 'out', file), path.join(dir, file));
  }
  const c = vscode.workspace.getConfiguration('workMonitor');
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ taskKeyPattern: c.get('taskKeyPattern'), generalBranches: c.get('generalBranches') }, null, 1),
  );
  return path.join(dir, 'mcp.js');
}

export async function connectAgent(serverPath: string): Promise<void> {
  const config = { command: 'node', args: [serverPath] };
  const choice = await vscode.window.showQuickPick(
    [
      {
        id: 'claude',
        label: '$(sparkle) Claude Code',
        detail: 'Registers the MCP server for all your projects and adds the /worklog command',
      },
      {
        id: 'copy',
        label: '$(copy) Other agents (Copilot, Cursor…)',
        detail: 'Copies the MCP server config to paste into the agent’s MCP settings',
      },
    ],
    { title: 'Connect a coding agent to Work Monitor' },
  );
  if (choice?.id === 'copy') {
    await vscode.env.clipboard.writeText(JSON.stringify({ [SERVER_NAME]: config }, null, 2));
    vscode.window.showInformationMessage('MCP config copied. Paste it into your agent’s MCP server settings.');
  } else if (choice?.id === 'claude') {
    await connectClaudeCode(serverPath);
  }
}

async function connectClaudeCode(serverPath: string): Promise<void> {
  const quoted = `"${serverPath}"`;
  // Remove first so re-running updates the registration instead of failing on "already exists".
  await run(`claude mcp remove --scope user ${SERVER_NAME}`).catch(() => undefined);
  try {
    await run(`claude mcp add --scope user ${SERVER_NAME} -- node ${quoted}`);
  } catch (e) {
    const manual = `claude mcp add --scope user ${SERVER_NAME} -- node ${quoted}`;
    const pick = await vscode.window.showErrorMessage(
      `Could not run the Claude CLI (${(e as Error).message.split('\n')[0]}). Run this yourself in a terminal:\n${manual}`,
      'Copy Command',
    );
    if (pick) {
      await vscode.env.clipboard.writeText(manual);
    }
    return;
  }

  const commandsDir = path.join(os.homedir(), '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'worklog.md'), WORKLOG_COMMAND);

  vscode.window.showInformationMessage(
    'Claude Code connected. Start a new Claude session, then type /worklog or ask "update the work monitor description".',
  );
}

function run(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    );
  });
}

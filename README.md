# Work Monitor

A VS Code extension that tracks the time you spend on each task automatically, based on your git branch. At the end of the day it gives you a ready-to-copy timesheet (for Odoo or any other form).

- **No timers to remember.** Check out `issue/TEST-101-…` and time is tracked for TEST-101.
- **Descriptions write themselves** from your commits. Your coding agent can also write a clean summary with `/worklog`.
- **Non-Jira work** (checking issues, reading docs, meetings) is a single click.
- **Works across several VS Code windows** without counting the same time twice.
- **Everything stays on your machine.**

---

## Contents

1. [Install](#1-install)
2. [First-time setup](#2-first-time-setup)
3. [Daily use](#3-daily-use)
4. [The timesheet](#4-the-timesheet)
5. [Non-Jira tasks](#5-non-jira-tasks)
6. [Jira](#6-jira)
7. [Coding agents and /worklog](#7-coding-agents-and-worklog)
8. [Settings](#8-settings)
9. [Troubleshooting](#9-troubleshooting)
10. [Your data](#10-your-data)
11. [Building from source](#11-building-from-source)

---

## 1. Install

You need **VS Code 1.93 or newer** and **Git**. Node.js is only needed for the coding-agent feature and for building from source.

### 1. Download

Open this repository's **Releases** page on GitHub (right sidebar → *Releases*). Under **Assets** of the latest release, download `work-monitor-<version>.vsix`.

### 2. Install the `.vsix`

**Option A: VS Code menu**

1. Open the **Extensions** view (`Ctrl+Shift+X`).
2. Click the **`…`** menu at the top of the view, then **Install from VSIX…**
3. Select the downloaded `work-monitor-<version>.vsix`.

**Option B: terminal**

```bash
code --install-extension work-monitor-<version>.vsix
```

### 3. Reload

Then **reload every open VS Code window**: `Ctrl+Shift+P` → **Developer: Reload Window**. A window that isn't reloaded doesn't track time.

### Check that it's running

- The **status bar** (bottom left) shows a clock, for example `🕒 Not tracking` or `● TEST-101 · 0m`.
- The **Activity Bar** (left edge) has a new **Work Monitor** clock icon.

### Updating

Download the newer `.vsix` from **Releases** and install it the same way. With the terminal, add `--force`:

```bash
code --install-extension work-monitor-<version>.vsix --force
```

Then reload your windows. Your tracked data is kept.

---

## 2. First-time setup

All of these steps are optional, but recommended.

| Step | Command (`Ctrl+Shift+P`) | Why |
|---|---|---|
| Connect Jira | **Work Monitor: Connect Jira…** | Real issue titles and "Open in Jira" links ([details](#6-jira)) |
| Connect your coding agent | **Work Monitor: Connect Coding Agent…** | Lets the agent write the task description with `/worklog` ([details](#7-coding-agents-and-worklog)) |
| Adjust settings | **Preferences: Open Settings** → search "Work Monitor" | Idle time, reminder time, rounding… ([details](#8-settings)) |

---

## 3. Daily use

Work as usual. Name branches with the task key and start commit messages with it:

```bash
git checkout -b issue/TEST-101-add-date-filter-to-orders-list
# … work, alone or with an agent …
git commit -m "TEST-101 added date filter to the orders query"
```

| You do | Work Monitor does |
|---|---|
| Check out a branch containing a task key (`TEST-101`) | Starts tracking **TEST-101** |
| Type, scroll, run terminal commands, or let an agent change files | Counts the time as active |
| Nothing at all for 10 minutes | Stops counting at your **last activity** and resumes on the next one |
| Commit with `TEST-101 …` | Adds the message to the task's description |
| Switch to another task branch | Closes TEST-101 and starts the new task |
| Switch to `main`, `develop`… | Logs the time as **General** (this can be turned off) |
| Close VS Code | Saves everything; the time ends at your last activity |

The task key can be anywhere in the branch name. `issue/TEST-101-…`, `feature/TEST-101`, `TEST-101-fix` and `bugfix/TEST-101_x` all work.

### Status bar

| Shows | Meaning |
|---|---|
| `● TEST-101 · 1h 23m` | Tracking now. The time is today's total for this task. |
| `🕒 TEST-101 · 1h 23m (idle)` | No activity for a while. Resumes when you do something. |
| `⏸ Paused` | You paused tracking (lunch, break…). |
| `🕒 Not tracking` | No task detected. |

**Click the status bar** for a quick menu:

- Open Timesheet
- Start or Stop Non-Jira Task
- Add Note
- Open in Jira
- Pause or Resume

### Sidebar

The **Work Monitor** icon in the Activity Bar lists today's tasks with their time ranges and durations, and today's total in the header. The green dot marks the task being tracked right now. The toolbar has Open Timesheet, Start Non-Jira Task, Pause and Refresh. The **`…`** menu has Connect Jira, Connect Coding Agent and Open Data Folder.

### Notes

**Work Monitor: Add Note to Current Task…**, also in the status bar menu, adds a line to the current task's description. Use it for things commits don't show, for example "Discussed sorting rules with backend team".

---

## 4. The timesheet

Open it from the sidebar (table icon), the status bar menu, or **Work Monitor: Open Timesheet**. A reminder also opens it at **17:30** every day; you can change the time in settings.

There is one card per task:

```
┌──────────────────────────────────────────────────────────────────────┐
│ [TEST-101] Add date filter to orders list                 ● Tracking │
│ START 09:12  →  END 11:40   HOURS 2:05   tracked 2h 05m              │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Added date filter to the orders query; updated list default …    │⧉│
│ └──────────────────────────────────────────────────────────────────┘ │
│ ▸ 2 commits · 1 note                 Copy  Open in Jira ↗  Reset  Hide│
└──────────────────────────────────────────────────────────────────────┘
```

| You can | How |
|---|---|
| Change title, start, end, hours or description | Just edit them. Changes save automatically. |
| Enter hours | `2:05`, `2.5`, `2h 30m` or `45m` |
| Copy one task for the Odoo form | **Copy** on the card, or **⧉** for only the description |
| Copy the whole day | **Copy all** at the top |
| Save a spreadsheet | **Export CSV** (columns Date, Task, Title, Start, End, Hours, Description) |
| Add something that wasn't tracked, such as a meeting | **+ Add entry**. Start the text with a key (`TEST-102 Code review`) to link it to a Jira task. |
| Leave a task out | **Hide**. It moves to "N hidden" at the bottom, where **Restore** brings it back. |
| Undo your edits | **Reset** goes back to the tracked times and the description built from commits |
| See another day | **‹ ›** next to the date |

The labels on a card mean:

- **Hours vs. tracked:** *Hours* is what goes on the timesheet. *Tracked* is the active time the extension measured. They differ only if you edited the hours or turned on rounding.
- **edited:** you changed something on this card.
- **✦ agent summary:** your coding agent wrote the description.

---

## 5. Non-Jira tasks

For work that isn't a Jira task, such as checking issues, reading documentation, meetings or support:

1. Click the status bar, then **Start Non-Jira Task…**, or use the **+** in the sidebar.
2. Pick a preset (Check issues, Refer docs, Meeting, Code review, Support), a recent one, or type a new name.
3. Click the status bar, then **Stop Non-Jira Task**, when you're done.

Non-Jira tasks **don't stop when VS Code is idle**, because that work often happens in the browser or in a meeting. While one runs, it takes priority over the branch task. When you stop it, branch tracking continues.

Tip: type `TEST-102 Code review` to track a Jira task that you're not working on in a branch.

---

## 6. Jira

### Connect

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens> (**Create API token**) and copy it.
2. In VS Code, run **Work Monitor: Connect Jira…**
3. Enter:
   - your site URL, for example `https://soluvia.atlassian.net`
   - your Atlassian email
   - the API token

You'll see "Jira connected as *your name*". The token is stored in VS Code's secure secret storage, never in settings files.

### What you get

- **Real issue titles** everywhere: status bar, sidebar, timesheet, copied text and CSV, and what your agent sees. Titles are fetched once and cached. Tasks tracked before you connected get their title the next time you switch to their branch.
- **Open in Jira** from the sidebar (link icon on a task), the timesheet card, or the status bar menu.

To change the account, run **Connect Jira…** again. To change the site, edit the `workMonitor.jira.baseUrl` setting.

---

## 7. Coding agents and /worklog

Your coding agent knows what it did, so it can write the timesheet description for you.

### Connect (once)

1. Run **Work Monitor: Connect Coding Agent…**
2. Choose:
   - **Claude Code**: registers the `work-monitor` tool for all your projects and adds the `/worklog` command. This needs the `claude` command-line tool to be installed.
   - **Other agents (Copilot, Cursor…)**: copies an MCP server config. Paste it into the agent's MCP settings.
3. **Start a new agent session.** Agents only load tools when a session starts.

To check, type `/mcp` in Claude Code. **work-monitor** should be listed as connected.

### Use

At any point, usually after finishing a piece of work, type:

```
/worklog
```

or ask in your own words: *"update the work monitor description with what we did"*. You can add details or a task key: `/worklog TEST-101 also mention the unit tests`.

The agent:

1. reads today's entry for the task on the current branch: the description, commits and notes,
2. writes **one clean summary that merges what was already there with the new work**, without duplicates,
3. saves it. The timesheet updates immediately and shows **✦ agent summary**.

You can still edit the text. **Reset** goes back to the description built from commits.

**Which task?** The task comes from the branch of the repo the agent works in, so two windows on two tasks each update the right one. On a branch without a key (`main`), the agent asks you, or you can pass the key: `/worklog TEST-101`.

---

## 8. Settings

Open them with **Preferences: Open Settings** and search for **Work Monitor**.

| Setting | Default | What it does |
|---|---|---|
| `workMonitor.idleMinutes` | `10` | Minutes without activity before time stops counting. Raise it if agents often run for a long time without changing files. |
| `workMonitor.autoStart` | `true` | Start tracking on branch switch. When `false`, you're asked first. |
| `workMonitor.generalBranches` | `main, master, develop, dev, staging` | Branches that aren't a task |
| `workMonitor.trackGeneralBranches` | `true` | Log time on those branches as **General**. Set to `false` to ignore it. |
| `workMonitor.manualTaskPresets` | `Check issues, Refer docs, Meeting, Code review, Support` | Quick choices for non-Jira tasks |
| `workMonitor.reminderTime` | `17:30` | Daily timesheet reminder (`HH:mm`). Empty turns it off. |
| `workMonitor.roundToMinutes` | `0` | Round durations to 5, 10, 15 or 30 minutes |
| `workMonitor.taskKeyPattern` | `[A-Z][A-Z0-9]+-\d+` | Regular expression for task keys |
| `workMonitor.jira.baseUrl` | *(empty)* | Your Jira site. Set by **Connect Jira…** |

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| No clock in the status bar | Reload the window (`Developer: Reload Window`). Check that **Work Monitor** is enabled in the Extensions view. |
| "Not tracking" on a task branch | The branch name must contain the key in capitals (`TEST-101`, not `test-101`), or adjust `taskKeyPattern`. Check that the folder is a git repository. |
| Time stopped while an agent was working | The agent didn't change any files for longer than `idleMinutes`. Increase that setting. |
| Wrong times or a forgotten entry | Fix it in the timesheet, or use **+ Add entry**. |
| The agent says `/worklog` or the tool doesn't exist | Start a **new** agent session after connecting. Run `/mcp` to check. Run **Connect Coding Agent…** again if needed. |
| `/worklog` doesn't work in a web or cloud session | The tool runs on your PC, so it only works in local sessions (VS Code panel or `claude` in a terminal). |
| "Could not run the Claude CLI" when connecting | Install Claude Code's command-line tool, or run the command shown in the message yourself. |
| Jira titles don't appear | Run **Connect Jira…** again and check the URL, email and token. Titles appear the next time the task's branch is active. |

---

## 10. Your data

Everything is stored locally. Nothing is sent anywhere except Jira title lookups, and only after you connect Jira. **Work Monitor: Open Data Folder** opens the folder:

```
%APPDATA%\Code\User\globalStorage\sandun.work-monitor\
├─ days\<date>\<window-id>.json   tracked time, commits and notes (one file per VS Code window)
├─ overrides\<date>.json          your timesheet edits and agent summaries
├─ titles.json                    cached Jira titles
└─ agent\                         the coding-agent tool (copied here so it survives updates)
```

The files are plain JSON. You can back them up, or delete a day's folder to remove it.

---

## 11. Building from source

```bash
npm install
npm run compile                     # or: npm run watch
```

- **Try it without installing:** open this folder in VS Code and press **F5**. A second VS Code window opens with the extension loaded.
- **Build the installable file:**

  ```bash
  npm run package
  # → work-monitor-<version>.vsix
  ```

### Publishing a release

The workflow in `.github/workflows/release.yml` runs automatically on every push to `main`.

- **New version in `package.json`:** it builds the `.vsix` and publishes the release `v<version>`.
- **Same version as an existing release:** it only builds, which checks that `main` still packages. Nothing is published.

To release:

1. Bump `"version"` in `package.json`, for example `0.3.0`.
2. Commit and push to `main`.
3. After about a minute, **Work Monitor v0.3.0** appears under **Releases**, with `work-monitor-0.3.0.vsix` attached and install instructions. The `v0.3.0` tag is created for you.

You can also start it from **Actions → Release → Run workflow**, or by pushing a tag `v0.3.0` that matches `package.json`. A version is only ever released once. Every build's `.vsix` is also kept under the run's **Artifacts**.

### Project layout

| Path | What's inside |
|---|---|
| `src/extension.ts` | Entry point: commands, status bar menu, reminder |
| `src/tracker.ts` | Activity detection, idle handling, segments per task |
| `src/git.ts` | Branch switches and new commits, from VS Code's Git extension |
| `src/report.ts` | Builds a day's timesheet (merges windows, applies edits), text and CSV |
| `src/timesheet.ts`, `media/` | The timesheet screen |
| `src/tree.ts`, `src/statusBar.ts` | Sidebar and status bar |
| `src/jira.ts` | Jira connection and titles |
| `src/mcp.ts`, `src/agent.ts` | Coding-agent tool (MCP server) and the Connect command |
| `src/store.ts` | Reading and writing the JSON files |

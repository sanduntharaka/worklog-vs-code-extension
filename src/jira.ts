import * as vscode from 'vscode';
import { getConfig } from './config';
import { Store } from './store';

const EMAIL_KEY = 'workMonitor.jira.email';
const TOKEN_KEY = 'workMonitor.jira.token';

/** Jira Cloud: real issue titles and links. Credentials live in VS Code's secret storage. */
export class Jira implements vscode.Disposable {
  private readonly pending = new Set<string>();
  private readonly titleEmitter = new vscode.EventEmitter<{ key: string; title: string }>();
  readonly onDidResolveTitle = this.titleEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage, private readonly store: Store) {}

  browseUrl(key: string): string | undefined {
    const base = getConfig().jiraBaseUrl;
    return base ? `${base}/browse/${key}` : undefined;
  }

  async connect(): Promise<void> {
    let base = getConfig().jiraBaseUrl;
    if (!base) {
      const input = await vscode.window.showInputBox({
        title: 'Connect Jira (1/3)',
        prompt: 'Your Jira Cloud site URL',
        placeHolder: 'https://your-company.atlassian.net',
        ignoreFocusOut: true,
        validateInput: v => (/^https:\/\/.+/.test(v.trim()) ? undefined : 'Enter a https:// URL'),
      });
      if (!input) {
        return;
      }
      base = input.trim().replace(/\/+$/, '');
      await vscode.workspace.getConfiguration('workMonitor').update('jira.baseUrl', base, vscode.ConfigurationTarget.Global);
    }
    const email = await vscode.window.showInputBox({
      title: 'Connect Jira (2/3)',
      prompt: 'Your Atlassian account email',
      value: (await this.secrets.get(EMAIL_KEY)) ?? '',
      ignoreFocusOut: true,
    });
    if (!email) {
      return;
    }
    const token = await vscode.window.showInputBox({
      title: 'Connect Jira (3/3)',
      prompt: 'API token — create one at id.atlassian.com/manage-profile/security/api-tokens',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) {
      return;
    }
    const res = await this.request(base, '/rest/api/3/myself', email.trim(), token.trim()).catch(() => undefined);
    if (!res?.ok) {
      vscode.window.showErrorMessage(`Could not connect to Jira (${res?.status ?? 'network error'}). Check the URL, email and token.`);
      return;
    }
    await this.secrets.store(EMAIL_KEY, email.trim());
    await this.secrets.store(TOKEN_KEY, token.trim());
    const me = (await res.json()) as { displayName?: string };
    vscode.window.showInformationMessage(`Jira connected${me.displayName ? ` as ${me.displayName}` : ''}.`);
  }

  /** Fetch the issue summary once and cache it; fires onDidResolveTitle when it arrives. */
  async resolveTitle(key: string): Promise<void> {
    if (this.pending.has(key) || this.store.getTitle(key)) {
      return;
    }
    const base = getConfig().jiraBaseUrl;
    const email = await this.secrets.get(EMAIL_KEY);
    const token = await this.secrets.get(TOKEN_KEY);
    if (!base || !email || !token) {
      return;
    }
    this.pending.add(key);
    try {
      const res = await this.request(base, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`, email, token);
      if (res.ok) {
        const issue = (await res.json()) as { fields?: { summary?: string } };
        const title = issue.fields?.summary;
        if (title) {
          this.store.setTitle(key, title);
          this.titleEmitter.fire({ key, title });
        }
      }
    } catch {
      // Offline or Jira unreachable; the branch-derived title is used meanwhile.
    } finally {
      this.pending.delete(key);
    }
  }

  private request(base: string, path: string, email: string, token: string): Promise<Response> {
    return fetch(base + path, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        Accept: 'application/json',
      },
    });
  }

  dispose(): void {
    this.titleEmitter.dispose();
  }
}

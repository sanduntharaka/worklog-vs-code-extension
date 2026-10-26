import * as vscode from 'vscode';

// Minimal slice of the built-in Git extension API (extensions/git/src/api/git.d.ts).
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
  getRepository(uri: vscode.Uri): Repository | null;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
    readonly onDidChange: vscode.Event<void>;
  };
  getCommit(ref: string): Promise<Commit>;
  getConfig(key: string): Promise<string>;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly authorDate?: Date;
  readonly commitDate?: Date;
  readonly authorEmail?: string;
}

export interface NewCommit {
  repo: Repository;
  commit: Commit;
}

/** Watches every repository in the window for branch switches and new local commits. */
export class GitWatcher implements vscode.Disposable {
  private api: GitAPI | undefined;
  private readonly heads = new Map<string, { branch?: string; commit?: string }>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly branchEmitter = new vscode.EventEmitter<void>();
  private readonly commitEmitter = new vscode.EventEmitter<NewCommit>();

  readonly onDidChangeBranch = this.branchEmitter.event;
  readonly onDidCommit = this.commitEmitter.event;

  async init(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) {
      return;
    }
    const gitExt = ext.isActive ? ext.exports : await ext.activate();
    if (!gitExt.enabled) {
      return;
    }
    this.api = gitExt.getAPI(1);
    this.api.repositories.forEach(r => this.watch(r));
    this.disposables.push(
      this.api.onDidOpenRepository(r => this.watch(r)),
      this.api.onDidCloseRepository(() => this.branchEmitter.fire()),
    );
  }

  /** The repository of the active editor, or the first one in the workspace. */
  currentRepo(): Repository | undefined {
    if (!this.api) {
      return undefined;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && uri.scheme === 'file' && this.api.getRepository(uri)) || this.api.repositories[0];
  }

  private watch(repo: Repository): void {
    const id = repo.rootUri.toString();
    this.heads.set(id, { branch: repo.state.HEAD?.name, commit: repo.state.HEAD?.commit });
    this.disposables.push(repo.state.onDidChange(() => this.onRepoChange(repo)));
    this.branchEmitter.fire();
  }

  private async onRepoChange(repo: Repository): Promise<void> {
    const id = repo.rootUri.toString();
    const prev = this.heads.get(id) ?? {};
    const head = repo.state.HEAD;
    this.heads.set(id, { branch: head?.name, commit: head?.commit });

    if (head?.name !== prev.branch) {
      this.branchEmitter.fire();
      return;
    }
    if (!head?.commit || head.commit === prev.commit) {
      return;
    }
    // HEAD moved on the same branch: a commit, amend, pull or rebase.
    // Only keep fresh commits written by the current user.
    try {
      const commit = await repo.getCommit(head.commit);
      const when = (commit.commitDate ?? commit.authorDate)?.getTime() ?? 0;
      if (Date.now() - when > 10 * 60_000) {
        return;
      }
      const me = await repo.getConfig('user.email').catch(() => '');
      if (me && commit.authorEmail && me.toLowerCase() !== commit.authorEmail.toLowerCase()) {
        return;
      }
      this.commitEmitter.fire({ repo, commit });
    } catch {
      // Commit could not be read; nothing to record.
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.branchEmitter.dispose();
    this.commitEmitter.dispose();
  }
}

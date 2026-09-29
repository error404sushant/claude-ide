import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import type { CanUseTool, HookCallback, Options, PermissionMode, PermissionResult, PreToolUseHookInput, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { startRecording, stopRecording } from './voice';
import { log, ReviewStore, registerReviewUi, snapshotWorkspace, recordBashChanges, WorkspaceSnapshot, proposed, PROPOSED_SCHEME } from './review';

type Mode = 'auto' | 'ask' | 'askBeforeEach' | 'plan';
const SDK_MODE: Record<Mode, PermissionMode> = { auto: 'acceptEdits', ask: 'acceptEdits', askBeforeEach: 'default', plan: 'plan' };
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
type Image = { name: string; mediaType: string; data: string };

/** The prompt as one streamed user message: carries images, and our own uuid so "Restore to here" can find it in the transcript. */
async function* userMessage(text: string, images: Image[], uuid: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user', uuid, parent_tool_use_id: null,
    message: { role: 'user', content: [...images.map(i => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.data } })), { type: 'text' as const, text }] },
  } as SDKUserMessage;
}
/** Splits a transcript prompt back into what the user typed and the files they attached (see `send`). */
function parsePrompt(text: string) {
  let refs: string[] = [];
  text = text.replace(/\n\n\(Attached: (.*)\)$/, (_, a: string) => { refs = a.split(' ').map(r => r.replace(/^@/, '')); return ''; });
  text = text.replace(/\n\n\((Current file: @[^\n]*|Selection in @[\s\S]*)$/, '');
  return { text, refs };
}
const cfg = () => vscode.workspace.getConfiguration('claudeIde');
const sdk = () => import('@anthropic-ai/claude-agent-sdk');

const isWin = process.platform === 'win32';
/** VS Code writes Windows drive letters in lowercase (c:\\); Claude reports C:\\. Match VS Code so paths compare equal. */
const normPath = (p: string) => (isWin ? p.replace(/^[A-Z]:/, d => d.toLowerCase()) : p);
const pathKey = () => Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';   // "Path" on Windows
const CLAUDE_HOME = normPath(path.join(os.homedir(), '.claude') + path.sep);

function findOnPath(name: string) {
  for (const dir of (process.env[pathKey()] ?? '').split(path.delimiter)) {
    const p = dir && path.join(dir, name);
    if (p && fs.existsSync(p)) return p;
  }
}

function findClaude(): string | undefined {
  const configured = cfg().get<string>('claudePath');
  if (configured) return configured;
  const home = os.homedir(), exe = isWin ? 'claude.exe' : 'claude';
  // GUI-launched editors often lack the shell PATH, so probe the usual install locations first.
  const known = [path.join(home, '.local', 'bin', exe), path.join(home, '.claude', 'local', exe), ...(isWin ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'])];
  return known.find(p => fs.existsSync(p)) ?? findOnPath(exe);
}

const shortInput = (name: string, input: any, cwd: string): string => {
  const rel = (p?: string) => {
    if (!p) return '';
    for (const base of [cwd, (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })()]) {
      const r = path.relative(base, p);
      if (!r.startsWith('..') && !path.isAbsolute(r)) return r || p;
    }
    return p;
  };
  switch (name) {
    case 'Read': return rel(input.file_path);
    case 'Edit': case 'MultiEdit': case 'Write': return rel(input.file_path);
    case 'NotebookEdit': return rel(input.notebook_path);
    case 'Bash': return input.command ?? '';
    case 'Grep': return `${input.pattern}${input.path ? ' in ' + rel(input.path) : ''}`;
    case 'Glob': return input.pattern ?? '';
    case 'WebFetch': return input.url ?? '';
    case 'WebSearch': return input.query ?? '';
    case 'Task': case 'Agent': return input.description ?? '';
    case 'TodoWrite': return `${input.todos?.length ?? 0} todos`;
    default: return JSON.stringify(input).slice(0, 120);
  }
};
const editStats = (name: string, input: any) => {
  const lines = (s?: string) => (s ? s.split('\n').length : 0);
  if (name === 'Edit') return { add: lines(input.new_string), del: lines(input.old_string) };
  if (name === 'MultiEdit') return (input.edits ?? []).reduce((a: any, e: any) => ({ add: a.add + lines(e.new_string), del: a.del + lines(e.old_string) }), { add: 0, del: 0 });
  if (name === 'Write') return { add: lines(input.content), del: 0 };
  return undefined;
};

/** Content a proposed Edit/MultiEdit/Write would leave on disk (for "Ask before each edit"). */
function proposedContent(name: string, input: any): string | undefined {
  const cur = (() => { try { return fs.readFileSync(input.file_path, 'utf8'); } catch { return ''; } })();
  const edit = (s: string, e: any) => (e.replace_all ? s.split(e.old_string).join(e.new_string) : s.replace(e.old_string, () => e.new_string));
  if (name === 'Write') return input.content;
  if (name === 'Edit') return edit(cur, input);
  if (name === 'MultiEdit') return (input.edits ?? []).reduce(edit, cur);
}

function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

class ChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private q?: Query;
  private abort?: AbortController;
  private sessionId?: string;
  private title = 'New chat';
  private folder?: string;
  private model = cfg().get<string>('defaultModel')!;
  private effort = 'high';
  private mode = cfg().get<Mode>('permissionMode')!;
  private turn = '';
  authed = false;
  private permissionWaiters = new Map<string, (choice: string) => void>();
  private bashSnaps = new Map<string, WorkspaceSnapshot>();
  private historyTimer?: NodeJS.Timeout;
  private autoResumed = false;
  /** Set by "Restore to here": the next prompt continues the conversation from this transcript entry. */
  private rewindTo?: string;

  constructor(private ctx: vscode.ExtensionContext, private store: ReviewStore, private ui: ReturnType<typeof registerReviewUi>) {
    store.onChange(() => this.postChanges());
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(os.homedir(), '.claude/projects')), '**/*.jsonl'));
    const refresh = () => { clearTimeout(this.historyTimer); this.historyTimer = setTimeout(() => this.sendHistory(), 500); };
    ctx.subscriptions.push(watcher, watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh));
  }

  private get cwd() { return this.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(); }

  /**
   * Claude Code reports real paths (e.g. /private/tmp/x) while the editor may have opened the folder through a
   * symlink (/tmp/x). Map tool paths back into the workspace's form so the review UI matches open editors.
   */
  private toWorkspacePath(p: string) {
    const abs = normPath(path.resolve(this.cwd, p));
    let real: string;
    try { real = normPath(fs.realpathSync(this.cwd)); } catch { return abs; }
    return real !== this.cwd && (abs === real || abs.startsWith(real + path.sep)) ? this.cwd + abs.slice(real.length) : abs;
  }
  private post(msg: any) { void this.view?.webview.postMessage(msg); }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2);
    const uri = (f: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource} data:;">
<link rel="stylesheet" href="${uri('main.css')}"></head><body><div id="app"></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.post({ type: 'error', text: String(e?.message ?? e) })));
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case 'ready': return this.init();
      case 'send': return this.send(m.text, m.attach, m.images, m.refs);
      case 'stop': return this.stop();
      case 'setModel': this.model = m.value; return this.q?.setModel(m.value);
      case 'setEffort': this.effort = m.value; return;
      case 'setMode':
        this.mode = m.value;
        void cfg().update('permissionMode', m.value, vscode.ConfigurationTarget.Global);
        return this.q?.setPermissionMode(SDK_MODE[this.mode]);
      case 'setFolder': this.folder = m.value; this.newChat(); void this.loadCommands(); return this.sendHistory();
      case 'newChat': return this.newChat();
      case 'history': return this.sendHistory();
      case 'openSession': return this.openSession(m.id);
      case 'pickFile': return this.pickFile(m.inline !== false);
      case 'permission': this.permissionWaiters.get(m.id)?.(m.choice); this.permissionWaiters.delete(m.id); return;
      case 'open': return this.ui.open(m.path);
      case 'openDiff': return this.ui.openDiff(m.path);
      case 'accept': return vscode.commands.executeCommand('claudeIde.acceptFile', m.path);
      case 'reject': return vscode.commands.executeCommand('claudeIde.rejectFile', m.path);
      case 'acceptAll': return vscode.commands.executeCommand('claudeIde.acceptAll');
      case 'rejectAll': return vscode.commands.executeCommand('claudeIde.rejectAll');
      case 'review': return vscode.commands.executeCommand('claudeIde.review');
      case 'restore': return this.restore(m.turns);
      case 'micStart': {
        const err = await startRecording();
        return this.post(err ? { type: 'mic', state: 'idle', error: err } : { type: 'mic', state: 'recording' });
      }
      case 'micStop': {
        this.post({ type: 'mic', state: 'transcribing' });
        try {
          const text = await stopRecording();
          this.post({ type: 'mic', state: 'idle' });
          return text ? this.post({ type: 'insert', text: text + ' ' }) : undefined;
        } catch (e: any) {
          return this.post({ type: 'mic', state: 'idle', error: String(e?.message ?? e) });
        }
      }
      case 'trust': return vscode.commands.executeCommand('workbench.trust.manage');
      case 'signIn': return this.signIn();
      case 'checkAuth': return this.checkAuth();
      case 'setApiKey': return vscode.commands.executeCommand('claudeIde.setApiKey');
      case 'dropFiles': return this.addFiles(m.uris);
      case 'openFileRef': {
        const p = path.resolve(this.cwd, m.path);
        return fs.existsSync(p) ? this.ui.open(p) : undefined;
      }
    }
  }

  private async init() {
    this.post({
      type: 'init', models: cfg().get<string[]>('models'), model: this.model, mode: this.mode, effort: this.effort,
      folders: (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, path: f.uri.fsPath })), folder: this.cwd, title: this.title,
    });
    this.postChanges();
    this.postActiveFile();
    this.post({ type: 'trust', ok: vscode.workspace.isTrusted });
    void this.loadCommands();
    await this.checkAuth();
    // Pick up where you left off: open this folder's most recent conversation once per window.
    if (!this.sessionId && !this.autoResumed && cfg().get('resumeLastConversation', true)) {
      this.autoResumed = true;
      const { listSessions } = await sdk();
      const latest = (await listSessions({ dir: this.cwd })).sort((a, b) => b.lastModified - a.lastModified)[0];
      if (latest) await this.openSession(latest.sessionId);
    }
  }

  trusted() { this.post({ type: 'trust', ok: true }); void this.loadCommands(); }

  private async agentEnv() {
    const extra = isWin ? [path.join(os.homedir(), '.local', 'bin')] : [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
    const key = pathKey();
    const env: Record<string, string | undefined> = { ...process.env, [key]: [...extra, process.env[key]].filter(Boolean).join(path.delimiter) };
    if (cfg().get('authMode') === 'apiKey') env.ANTHROPIC_API_KEY = await this.ctx.secrets.get('claudeIde.apiKey');
    return env;
  }

  /** Slash commands (built-ins, custom commands, skills, plugins) for the "/" menu, fetched without sending a message. */
  private commandsCwd?: string;
  private async loadCommands() {
    if (this.commandsCwd === this.cwd || !vscode.workspace.isTrusted) return;
    const cwd = this.commandsCwd = this.cwd;
    const abort = new AbortController();
    try {
      const { query } = await sdk();
      const idle = (async function* () { await new Promise(r => abort.signal.addEventListener('abort', r)); })();
      const q = query({ prompt: idle as AsyncIterable<SDKUserMessage>, options: {
        cwd, abortController: abort, persistSession: false, settingSources: ['user', 'project', 'local'],
        pathToClaudeCodeExecutable: findClaude(), env: await this.agentEnv(),
      } });
      const cmds = await Promise.race([q.supportedCommands(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))]);
      if (cwd === this.cwd) this.postCommands(cmds);
    } catch (e: any) {
      log.warn(`could not load slash commands: ${e?.message ?? e}`);
      if (cwd === this.commandsCwd) this.commandsCwd = undefined;
    } finally { abort.abort(); }
  }
  private postCommands(cmds: { name: string; description: string; argumentHint: string; aliases?: string[]; builtin?: boolean }[]) {
    this.post({ type: 'commands', commands: cmds.map(c => ({ name: c.name, description: c.description, hint: c.argumentHint, aliases: c.aliases ?? [], builtin: !!c.builtin })) });
  }

  postActiveFile() {
    const u = vscode.window.activeTextEditor?.document.uri;
    this.post({ type: 'activeFile', name: u?.scheme === 'file' ? path.basename(u.fsPath) : '' });
  }

  async checkAuth() {
    if (cfg().get('authMode') === 'apiKey') {
      const key = await this.ctx.secrets.get('claudeIde.apiKey');
      this.authed = !!key;
      return this.post({ type: 'auth', ok: !!key, detail: key ? 'API key' : 'No API key set' });
    }
    const bin = findClaude();
    if (!bin) return this.post({ type: 'auth', ok: false, detail: 'Claude Code not found. Install it: npm i -g @anthropic-ai/claude-code' });
    execFile(bin, ['auth', 'status'], { timeout: 15000 }, (err, stdout) => {
      let s: any = {};
      try { s = JSON.parse(stdout); } catch { /* older CLI: non-JSON output */ }
      const ok = s.loggedIn ?? !err;
      this.authed = ok;
      this.post({ type: 'auth', ok, detail: ok ? `Signed in (${s.authMethod ?? 'Claude Code'})` : 'Not signed in' });
    });
  }

  signIn() {
    // Run claude itself as the terminal process: no shell quoting differences between zsh, PowerShell and cmd.
    const t = vscode.window.createTerminal({ name: 'Claude sign-in', cwd: this.cwd, shellPath: findClaude() ?? (isWin ? 'claude.exe' : 'claude'), shellArgs: ['/login'] });
    t.show();
  }

  /** "Restore to here": undo Claude's file changes from that message on, drop those messages, and put the prompt back in the input. */
  private async restore(turns: string[]) {
    const ok = await vscode.window.showWarningMessage('Restore to before this message?',
      { modal: true, detail: 'Files Claude changed from this message on go back to how they were, and this message and the ones after it are removed. Your message goes back into the input box.' }, 'Restore');
    if (ok !== 'Restore') return;
    this.stop();
    while (this.q) await new Promise(r => setTimeout(r, 50));
    const n = this.store.restoreTo(turns);
    if (this.sessionId) {
      const { getSessionMessages } = await sdk();
      const msgs = await getSessionMessages(this.sessionId, { dir: this.cwd });
      const i = msgs.findIndex(m => m.uuid === turns[0]);
      if (i === 0) { this.sessionId = undefined; this.rewindTo = undefined; }   // first message: start over
      else if (i > 0) this.rewindTo = msgs[i - 1].uuid;
    }
    log.info(`restore ${turns[0]}: ${n} file(s), rewind to ${this.rewindTo ?? (this.sessionId ? 'unchanged' : 'new chat')}`);
    this.post({ type: 'rewound', turn: turns[0], files: n });
  }

  newChat() {
    this.stop();
    this.rewindTo = undefined;
    this.sessionId = undefined;
    this.title = 'New chat';
    this.post({ type: 'reset', title: this.title });
  }

  private postChanges() {
    this.post({
      type: 'changes', files: this.store.pending().map(f => ({
        ...f, name: path.basename(f.path), dir: path.relative(this.cwd, path.dirname(f.path)) || '.',
      })),
    });
  }

  private async sendHistory() {
    if (!this.view) return;
    const { listSessions } = await sdk();
    const sessions = await listSessions({ dir: this.cwd });
    this.post({
      type: 'history', sessions: sessions.sort((a, b) => b.lastModified - a.lastModified).map(s => ({
        id: s.sessionId, title: (s.customTitle || s.summary || s.firstPrompt || '(untitled)').slice(0, 60), time: s.lastModified,
        size: s.fileSize, branch: s.gitBranch, current: s.sessionId === this.sessionId,
      })),
    });
  }

  private async openSession(id: string) {
    this.stop();
    const { getSessionMessages, listSessions } = await sdk();
    const msgs = await getSessionMessages(id, { dir: this.cwd });
    const info = (await listSessions({ dir: this.cwd })).find(s => s.sessionId === id);
    this.sessionId = id;
    this.rewindTo = undefined;
    this.title = (info?.customTitle || info?.summary || info?.firstPrompt || 'Chat').slice(0, 60);
    this.post({ type: 'reset', title: this.title });
    // Very long conversations (hundreds of MB) would freeze the panel; show the latest part. Claude still has the full history.
    const MAX = 300;
    if (msgs.length > MAX) this.post({ type: 'note', text: `Showing the latest ${MAX} of ${msgs.length} messages.` });
    for (const m of msgs.slice(-MAX)) this.render(m as any, true);
    this.post({ type: 'done', replay: true });
    this.post({ type: 'scrollBottom' });
  }

  private async pickFile(inline = true) {
    const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,build,dist,out}/**', 5000);
    const items = files.map(f => vscode.workspace.asRelativePath(f, false)).sort();
    if (inline) {
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Reference a file' });
      if (pick) this.post({ type: 'insert', text: `@${pick} ` });
      return;
    }
    const picks = await vscode.window.showQuickPick(items, { placeHolder: 'Attach files', canPickMany: true });
    if (picks?.length) this.addFiles(picks.map(p => vscode.Uri.file(path.resolve(this.cwd, p)).toString()));
  }

  /** Files/folders/images dropped on the panel or picked: images become image blocks, the rest context chips. */
  addFiles(uris: string[]) {
    log.info(`addFiles ${JSON.stringify(uris)}`);
    for (const u of uris) {
      const p = /^[a-z][\w+.-]+:/i.test(u) ? vscode.Uri.parse(u).fsPath : u;   // URI (not a C:\ path)
      if (!fs.existsSync(p)) continue;
      const isDir = fs.statSync(p).isDirectory();
      const mediaType = IMAGE_TYPES[path.extname(p).toLowerCase()];
      if (mediaType && fs.statSync(p).size <= 5 * 1024 * 1024) {
        this.post({ type: 'attachImage', image: { name: path.basename(p), mediaType, data: fs.readFileSync(p).toString('base64') } });
        continue;
      }
      const rel = path.relative(this.cwd, p);
      this.post({ type: 'addRef', ref: { path: (rel && !rel.startsWith('..') ? rel : p) + (isDir ? '/' : ''), name: path.basename(p), isDir } });
    }
    void vscode.commands.executeCommand('claudeIde.chat.focus');
  }

  stop() {
    if (!this.q) return;
    void this.q.interrupt().catch(() => undefined);
    this.abort?.abort();
    for (const w of this.permissionWaiters.values()) w('deny');
    this.permissionWaiters.clear();
  }

  private ask(title: string, detail: string, choices: string[], extra: any = {}): Promise<string> {
    const id = Math.random().toString(36).slice(2);
    this.post({ type: 'permission', id, title, detail, choices, ...extra });
    return new Promise(res => this.permissionWaiters.set(id, res));
  }

  private canUseTool: CanUseTool = async (name, input: any, { signal, suggestions }): Promise<PermissionResult> => {
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    if (name === 'AskUserQuestion') {
      // Multiple-choice questions from Claude: the panel shows options + "Other" and returns question → answer.
      const id = Math.random().toString(36).slice(2);
      this.post({ type: 'question', id, questions: input.questions });
      const onAbort = () => this.permissionWaiters.get(id)?.('');
      signal.addEventListener('abort', onAbort);
      const reply = await new Promise<string>(res => this.permissionWaiters.set(id, res));
      signal.removeEventListener('abort', onAbort);
      if (!reply || reply === 'deny') return { behavior: 'deny', message: 'The user dismissed the questions without answering.' };
      return { behavior: 'allow', updatedInput: { ...input, answers: JSON.parse(reply) } };
    }
    if (this.mode === 'auto') return allow;
    let choice: string;
    const onAbort = () => this.permissionWaiters.forEach(w => w('deny'));
    signal.addEventListener('abort', onAbort);
    try {
      if (EDIT_TOOLS.has(name) && this.mode === 'plan') return { behavior: 'deny', message: 'Plan mode: nothing may be written yet. Present your plan with ExitPlanMode and wait for approval.' };
      if (EDIT_TOOLS.has(name) && this.mode !== 'askBeforeEach') return allow; // staged via baselines
      if (EDIT_TOOLS.has(name)) {
        const p = this.toWorkspacePath(input.file_path ?? input.notebook_path);
        const next = proposedContent(name, input);
        if (next !== undefined) {
          proposed.set(p, next);
          const left = fs.existsSync(p) ? vscode.Uri.file(p) : vscode.Uri.file(p).with({ scheme: PROPOSED_SCHEME, query: 'empty' });
          await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(p).with({ scheme: PROPOSED_SCHEME, query: String(Date.now()) }), `${path.basename(p)} (proposed by Claude)`, { preview: true });
        }
        choice = await this.ask(`${name} ${path.relative(this.cwd, p)}`, 'Review the proposed change in the editor.', ['Accept', 'Reject'], { kind: 'edit', path: p });
        choice = choice === 'Accept' ? 'allow' : 'deny';
      } else if (name === 'ExitPlanMode') {
        choice = await this.ask('Plan ready', input.plan ?? '', ['Approve plan', 'Keep planning'], { kind: 'plan' });
        if (choice !== 'Approve plan') return { behavior: 'deny', message: 'The user wants to keep planning.' };
        this.mode = 'ask';
        this.post({ type: 'mode', value: 'ask' });
        return { ...allow, updatedPermissions: [{ type: 'setMode', mode: SDK_MODE.ask, destination: 'session' }] };
      } else {
        choice = await this.ask(name, shortInput(name, input, this.cwd), ['Allow once', 'Always allow', 'Deny'], { kind: name === 'Bash' ? 'bash' : 'tool' });
        choice = choice === 'Always allow' ? 'always' : choice === 'Allow once' ? 'allow' : 'deny';
      }
    } finally { signal.removeEventListener('abort', onAbort); }
    if (choice === 'always') return { ...allow, updatedPermissions: suggestions };
    if (choice === 'allow') return allow;
    return { behavior: 'deny', message: 'The user rejected this action.' };
  };

  private preToolUse: HookCallback = async input => {
    const i = input as PreToolUseHookInput, t: any = i.tool_input;
    log.info(`PreToolUse ${i.tool_name} mode=${this.mode}`);
    if (EDIT_TOOLS.has(i.tool_name)) {
      const f = t.file_path ?? t.notebook_path;
      const p = f && this.toWorkspacePath(f);
      // Claude's own state (plans, memory) is not user code; keep it out of the review stack.
      if (p && !p.startsWith(CLAUDE_HOME)) this.store.snapshot(p, this.turn);
    } else if (i.tool_name === 'Bash' && this.mode !== 'plan') {
      this.bashSnaps.set(i.tool_use_id, snapshotWorkspace(this.cwd));
    }
    return { continue: true };
  };

  private postToolUse: HookCallback = async (input: any) => {
    const snap = this.bashSnaps.get(input.tool_use_id);
    if (snap) { this.bashSnaps.delete(input.tool_use_id); recordBashChanges(this.store, this.cwd, snap, this.turn); }
    // Edits approved one-by-one are final; keep only the checkpoint for "Restore to here".
    if (this.mode === 'askBeforeEach' && EDIT_TOOLS.has(input.tool_name)) {
      const p = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (p) this.store.accept(this.toWorkspacePath(p));
    }
    this.store.settle();
    return { continue: true };
  };

  async send(text: string, attach: boolean, images: Image[] = [], refs: string[] = []) {
    log.info(`send ${JSON.stringify(text.slice(0, 80))}`);
    if (!vscode.workspace.isTrusted) return this.post({ type: 'trust', ok: false });
    if (this.q) return this.post({ type: 'error', text: 'Claude is still working. Stop it first.' });
    if (cfg().get('blockUntilReviewed') && this.store.pending().length)
      return this.post({ type: 'error', text: 'Review pending changes before sending another prompt.' });
    if (text.trim() === '/clear') return this.newChat();

    let prompt = text;
    const ed = vscode.window.activeTextEditor;
    if (attach && ed?.document.uri.scheme === 'file') {
      const rel = path.relative(this.cwd, ed.document.uri.fsPath);
      const sel = ed.selection;
      prompt += sel.isEmpty
        ? `\n\n(Current file: @${rel})`
        : `\n\n(Selection in @${rel} lines ${sel.start.line + 1}-${sel.end.line + 1}:)\n\`\`\`\n${ed.document.getText(sel)}\n\`\`\``;
    }

    if (refs.length) prompt += `\n\n(Attached: ${refs.map(r => '@' + r).join(' ')})`;

    this.turn = randomUUID();
    if (!this.sessionId) this.title = text.slice(0, 60);
    this.post({ type: 'user', text, turn: this.turn, title: this.title, images, refs });

    const env = await this.agentEnv();

    const options: Options = {
      cwd: this.cwd,
      model: this.model,
      effort: this.effort as Options['effort'],
      resume: this.sessionId,
      resumeSessionAt: this.sessionId ? this.rewindTo : undefined,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      permissionMode: SDK_MODE[this.mode],
      canUseTool: this.canUseTool,
      hooks: { PreToolUse: [{ hooks: [this.preToolUse] }], PostToolUse: [{ hooks: [this.postToolUse] }], PostToolUseFailure: [{ hooks: [this.postToolUse] }] },
      includePartialMessages: true,
      abortController: this.abort = new AbortController(),
      pathToClaudeCodeExecutable: findClaude(),
      env,
      stderr: d => log.warn('[claude]', d),
    };

    const { query } = await sdk();
    const started = Date.now();
    this.post({ type: 'busy', value: true });
    try {
      this.rewindTo = undefined;
      this.q = query({ prompt: userMessage(prompt, images, this.turn), options });
      for await (const m of this.q) this.render(m);
    } catch (e: any) {
      this.post({ type: 'done', error: this.abort.signal.aborted ? 'Stopped' : String(e?.message ?? e), durationMs: Date.now() - started });
    } finally {
      this.q = undefined;
      this.post({ type: 'busy', value: false });
      this.store.settle();
    }
  }

  private render(m: SDKMessage | any, replay = false) {
    const sub = m.parent_tool_use_id != null;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && !replay) {
          const isNew = this.sessionId !== m.session_id;
          this.sessionId = m.session_id;
          if (isNew) this.post({ type: 'title', text: this.title });
          void this.q?.supportedCommands().then(c => this.postCommands(c)).catch(() => undefined);
        }
        if (m.subtype === 'commands_changed') this.postCommands(m.commands);
        if (m.subtype === 'local_command_output' && !replay) this.post({ type: 'assistantText', text: m.content });
        // Leaving plan mode (plan approved) → continue in Ask mode so edits are staged for review.
        if (m.subtype === 'status' && m.permissionMode && m.permissionMode !== 'plan' && this.mode === 'plan' && !replay) {
          this.mode = 'ask';
          this.post({ type: 'mode', value: 'ask' });
          void this.q?.setPermissionMode(SDK_MODE.ask).catch(() => undefined);
        }
        return;
      case 'stream_event': {
        const ev = m.event;
        if (!sub && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.post({ type: 'delta', text: ev.delta.text });
        return;
      }
      case 'assistant':
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && !sub) this.post({ type: 'assistantText', text: b.text });
          // Questions and plan approvals get their own cards; the raw tool line would just duplicate them.
          if (b.type === 'tool_use' && !['AskUserQuestion', 'ExitPlanMode'].includes(b.name)) this.post({
            type: 'tool', id: b.id, name: b.name, summary: shortInput(b.name, b.input, this.cwd), sub,
            path: b.input?.file_path && this.toWorkspacePath(b.input.file_path), stats: editStats(b.name, b.input),
          });
        }
        return;
      case 'user': {
        const content = typeof m.message?.content === 'string' ? [{ type: 'text', text: m.message.content }] : m.message?.content ?? [];
        for (const b of content) if (b.type === 'tool_result') this.post({ type: 'toolResult', id: b.tool_use_id, output: toolOutput(b.content).slice(0, 20000), isError: !!b.is_error });
        const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        if (replay && !sub && text && !text.startsWith('<')) {
          const images = content.filter((b: any) => b.type === 'image' && b.source?.type === 'base64')
            .map((b: any) => ({ name: 'image', mediaType: b.source.media_type, data: b.source.data }));
          this.post({ type: 'user', turn: m.uuid, images, ...parsePrompt(text) });
        }
        return;
      }
      case 'result':
        this.post({
          type: 'done', durationMs: m.duration_ms, cost: m.total_cost_usd,
          tokens: m.usage ? (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0) + (m.usage.output_tokens ?? 0) : undefined,
          error: m.subtype !== 'success' ? (m.errors?.join('\n') || m.subtype) : undefined,
        });
        return;
    }
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  const store = new ReviewStore(ctx.workspaceState);
  const ui = registerReviewUi(ctx, store);
  const chat = new ChatProvider(ctx, store, ui);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeIde.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('claudeIde.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('claudeIde.dropResources', (uris: string[]) => chat.addFiles(uris)),
    vscode.commands.registerCommand('claudeIde.signIn', () => chat.signIn()),
    vscode.commands.registerCommand('claudeIde.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ prompt: 'Anthropic API key', password: true, ignoreFocusOut: true });
      if (key === undefined) return;
      await ctx.secrets.store('claudeIde.apiKey', key);
      await cfg().update('authMode', 'apiKey', vscode.ConfigurationTarget.Global);
      await chat.checkAuth();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => chat.postActiveFile()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => chat.trusted()),
    vscode.window.onDidChangeWindowState(s => { if (s.focused && !chat.authed) void chat.checkAuth(); }),
  );
  // Show the Claude panel on the right the first time a workspace is opened; the layout is remembered after that.
  if (!ctx.workspaceState.get('claudeIde.revealed')) {
    void ctx.workspaceState.update('claudeIde.revealed', true);
    void vscode.commands.executeCommand('workbench.view.extension.claudeIde');
  }
  return { chat, store }; // used by the integration test
}

export function deactivate() {}

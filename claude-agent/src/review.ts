import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { applyHunk, computeHunks, diffStats, Hunk } from './hunks';

export type Status = 'A' | 'M' | 'D';
export interface Pending { path: string; status: Status; add: number; del: number }
type Checkpoint = { turn: string; files: Record<string, string | null> };

export const log = vscode.window.createOutputChannel('Claude IDE', { log: true });
const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function write(p: string, content: string | null) {
  if (content === null) { fs.rmSync(p, { force: true }); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Baselines = original content of every file Claude touched (null = did not exist). Disk holds the proposal. */
export class ReviewStore {
  private baselines = new Map<string, string | null>();
  private checkpoints: Checkpoint[] = [];
  /** Snapshotted but the tool has not written yet — must not be pruned as "unchanged". */
  private settling = new Set<string>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onChange = this.emitter.event;

  constructor(readonly state: vscode.Memento) {
    this.baselines = new Map(Object.entries(state.get<Record<string, string | null>>('claudeIde.baselines', {})));
    this.checkpoints = state.get<Checkpoint[]>('claudeIde.checkpoints', []);
    this.prune();
  }

  baseline(p: string) { return this.baselines.get(p); }
  has(p: string) { return this.baselines.has(p); }

  /** Call before a tool modifies `p`. Records its pre-image once per review set and once per turn. */
  snapshot(p: string, turn: string, content: string | null = read(p)) {
    if (!this.baselines.has(p)) { this.baselines.set(p, content); log.info(`baseline ${p} (${content === null ? 'new file' : content.length + ' chars'}) turn=${turn}`); }
    let cp = this.checkpoints.find(c => c.turn === turn);
    if (!cp) this.checkpoints.push(cp = { turn, files: {} });
    if (!(p in cp.files)) cp.files[p] = content;
    this.settling.add(p);
    this.save();
  }
  /** Call once the tool that triggered `snapshot` has finished. */
  settle() { this.settling.clear(); this.refresh(); }

  pending(): Pending[] {
    const out: Pending[] = [];
    for (const [p, base] of this.baselines) {
      const cur = read(p);
      if (cur === base) continue;
      out.push({ path: p, status: base === null ? 'A' : cur === null ? 'D' : 'M', ...diffStats(base ?? '', cur ?? '') });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  hunks(p: string, cur = read(p)): Hunk[] {
    const base = this.baselines.get(p);
    return base === undefined ? [] : computeHunks(base ?? '', cur ?? '');
  }

  accept(p: string) { log.info(`accept ${p}`); this.baselines.delete(p); this.save(); }
  reject(p: string) {
    log.info(`reject ${p}`);
    if (!this.baselines.has(p)) return;
    write(p, this.baselines.get(p)!);
    this.baselines.delete(p);
    this.save();
  }
  acceptAll() { log.info('acceptAll'); this.baselines.clear(); this.save(); }
  rejectAll() { for (const p of [...this.baselines.keys()]) this.reject(p); }

  acceptHunk(p: string, i: number) {
    const base = this.baselines.get(p);
    if (base === undefined) return;
    this.baselines.set(p, applyHunk(base ?? '', read(p) ?? '', i, 'accept'));
    this.save();
  }
  rejectHunk(p: string, i: number) {
    const base = this.baselines.get(p);
    if (base === undefined) return;
    const next = applyHunk(base ?? '', read(p) ?? '', i, 'reject');
    // Rejecting the only hunk of a new file (or restoring a deleted one) restores the exact original.
    write(p, base === null && next === '' ? null : next);
    this.save();
  }

  /** Undo every change made in these turns (a message and the ones after it). */
  restoreTo(turns: string[]) {
    const ids = new Set(turns);
    const restore = new Map<string, string | null>();
    for (const cp of this.checkpoints.filter(c => ids.has(c.turn)))   // oldest first: the earliest pre-image wins
      for (const [p, c] of Object.entries(cp.files)) if (!restore.has(p)) restore.set(p, c);
    for (const [p, c] of restore) write(p, c);
    this.checkpoints = this.checkpoints.filter(c => !ids.has(c.turn));
    this.save();
    return restore.size;
  }

  /** Drops files whose disk content equals the baseline. */
  prune() {
    let changed = false;
    for (const [p, base] of this.baselines) if (!this.settling.has(p) && read(p) === base) { log.info(`unchanged, dropped ${p}`); this.baselines.delete(p); changed = true; }
    return changed;
  }

  save() {
    this.prune();
    void this.state.update('claudeIde.baselines', Object.fromEntries(this.baselines));
    void this.state.update('claudeIde.checkpoints', this.checkpoints.slice(-50));
    this.emitter.fire();
  }
  refresh() { if (this.prune()) this.save(); else this.emitter.fire(); }
}

// ---------- Bash change detection ----------

const SKIP = new Set(['.git', 'node_modules', '.dart_tool', 'build', 'dist', 'out', '.next', 'Pods', '.gradle', 'target', '.venv', '__pycache__']);
// Note: caps keep snapshots cheap; files beyond them are not tracked for Bash edits. Use git plumbing if that matters.
const MAX_FILES = 20000, MAX_BYTES = 512 * 1024;
type Entry = { mtimeMs: number; size: number; content: string | null };
const cache = new Map<string, Entry>();

function walk(root: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); }
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export type WorkspaceSnapshot = Map<string, Entry>;

export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const snap: WorkspaceSnapshot = new Map();
  for (const p of walk(root)) {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    let e = cache.get(p);
    if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
      e = { mtimeMs: st.mtimeMs, size: st.size, content: st.size <= MAX_BYTES ? read(p) : null };
      if (e.content?.includes('\0')) e.content = null; // binary
      cache.set(p, e);
    }
    snap.set(p, e);
  }
  return snap;
}

/** Records baselines for every file a Bash command created, changed or deleted. */
export function recordBashChanges(store: ReviewStore, root: string, before: WorkspaceSnapshot, turn: string) {
  const after = snapshotWorkspace(root);
  for (const [p, a] of after) {
    const b = before.get(p);
    if (!b) store.snapshot(p, turn, null);
    else if (b.content !== null && (b.mtimeMs !== a.mtimeMs || b.size !== a.size)) store.snapshot(p, turn, b.content);
  }
  for (const [p, b] of before) if (!after.has(p) && b.content !== null) store.snapshot(p, turn, b.content);
}

// ---------- Editor UI ----------

export const BASELINE_SCHEME = 'claude-baseline';
export const PROPOSED_SCHEME = 'claude-proposed';
export const proposed = new Map<string, string>();

const cfg = () => vscode.workspace.getConfiguration('claudeIde');

export function registerReviewUi(ctx: vscode.ExtensionContext, store: ReviewStore) {
  const contentChanged = new vscode.EventEmitter<vscode.Uri>();
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
    onDidChange: contentChanged.event,
    provideTextDocumentContent: u => store.baseline(u.fsPath) ?? '',
  }));
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
    provideTextDocumentContent: u => (u.query === 'empty' ? '' : proposed.get(u.fsPath) ?? ''),
  }));

  // Explorer "Claude Changes" tree
  const treeChanged = new vscode.EventEmitter<void>();
  const tree = vscode.window.createTreeView('claudeIde.changes', {
    treeDataProvider: {
      onDidChangeTreeData: treeChanged.event,
      getChildren: () => store.pending(),
      getTreeItem: (f: Pending) => {
        const item = new vscode.TreeItem(vscode.Uri.file(f.path));
        const dir = path.dirname(vscode.workspace.asRelativePath(f.path));
        item.description = `${f.status}  +${f.add} −${f.del}${dir === '.' ? '' : '  ' + dir}`;
        item.contextValue = 'pending';
        item.command = { command: 'claudeIde.open', title: 'Open', arguments: [f.path] };
        return item;
      },
    },
  });

  // Badges on files in Explorer / tabs
  const decoChanged = new vscode.EventEmitter<vscode.Uri[]>();
  let lastPending: Pending[] = [];
  ctx.subscriptions.push(vscode.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decoChanged.event,
    provideFileDecoration: u => {
      const f = lastPending.find(p => p.path === u.fsPath);
      if (!f || u.scheme !== 'file') return;
      const color = { A: 'gitDecoration.addedResourceForeground', M: 'gitDecoration.modifiedResourceForeground', D: 'gitDecoration.deletedResourceForeground' }[f.status];
      return { badge: f.status, tooltip: `Claude: pending (+${f.add} −${f.del})`, color: new vscode.ThemeColor(color), propagate: true };
    },
  }));

  // In-editor highlights
  const addedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(40, 167, 69, 0.15)',
    borderColor: 'rgba(40, 167, 69, 0.8)', borderStyle: 'solid', borderWidth: '0 0 0 3px',
    overviewRulerColor: 'rgba(40, 167, 69, 0.8)', overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const removedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: 'rgba(220, 53, 69, 0.8)', borderStyle: 'solid', borderWidth: '2px 0 0 0',
    overviewRulerColor: 'rgba(220, 53, 69, 0.8)', overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  // Claude IDE (the fork) renders removed lines, per-hunk buttons and the review bar natively.
  let native = false;
  let nativeSent = new Set<string>();
  void vscode.commands.getCommands(false).then(c => { native = c.includes('_claudeIde.setReview'); update(); });
  const pushNative = () => {
    if (!native) return;
    const inline = cfg().get('reviewStyle') !== 'sideBySide';
    const now = new Set<string>();
    lastPending.forEach((f, i) => {
      if (!inline || f.status === 'D') return;
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f.path);
      now.add(f.path);
      void vscode.commands.executeCommand('_claudeIde.setReview', vscode.Uri.file(f.path), store.hunks(f.path, doc?.getText()), i, lastPending.length);
    });
    for (const p of nativeSent) if (!now.has(p)) void vscode.commands.executeCommand('_claudeIde.setReview', vscode.Uri.file(p), []);
    nativeSent = now;
  };

  const decorate = (ed: vscode.TextEditor) => {
    if (ed.document.uri.scheme !== 'file' || !store.has(ed.document.uri.fsPath) || cfg().get('reviewStyle') === 'sideBySide') {
      ed.setDecorations(addedDeco, []); ed.setDecorations(removedDeco, []); return;
    }
    const hunks = store.hunks(ed.document.uri.fsPath, ed.document.getText());
    const last = Math.max(0, ed.document.lineCount - 1);
    const added: vscode.DecorationOptions[] = [], removed: vscode.DecorationOptions[] = [];
    for (const h of hunks) {
      if (h.added) added.push({ range: new vscode.Range(h.start, 0, h.start + h.added - 1, 0) });
      if (!h.removed || native) continue;
      // Note: in stock VS Code, removed lines are shown as hover + ghost text; real view zones need the fork (see README).
      const line = Math.min(h.start, last);
      const first = h.removedText.split('\n')[0];
      removed.push({
        range: new vscode.Range(line, 0, line, 0),
        hoverMessage: new vscode.MarkdownString().appendMarkdown(`**Removed by Claude (${h.removed} line${h.removed > 1 ? 's' : ''})**`).appendCodeblock(h.removedText, ed.document.languageId),
        renderOptions: { after: { contentText: `  ⌫ −${h.removed}: ${first.trim().slice(0, 60)}${h.removed > 1 ? ' …' : ''}`, color: 'rgba(220, 53, 69, 0.9)', textDecoration: 'none; text-decoration: line-through; opacity: 0.8', fontStyle: 'italic' } },
      });
    }
    ed.setDecorations(addedDeco, added);
    ed.setDecorations(removedDeco, removed);
  };

  // Per-hunk Accept | Reject lenses
  const lensChanged = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses: doc => {
      if (native || !cfg().get('showHunkCodeLens') || !store.has(doc.uri.fsPath)) return [];
      return store.hunks(doc.uri.fsPath, doc.getText()).flatMap((h, i) => {
        const r = new vscode.Range(Math.min(h.start, Math.max(0, doc.lineCount - 1)), 0, Math.min(h.start, Math.max(0, doc.lineCount - 1)), 0);
        return [
          new vscode.CodeLens(r, { title: '$(check) Accept ⌥⏎', command: 'claudeIde.acceptHunk', arguments: [doc.uri.fsPath, i] }),
          new vscode.CodeLens(r, { title: '$(discard) Reject ⇧⌥⌫', command: 'claudeIde.rejectHunk', arguments: [doc.uri.fsPath, i] }),
          new vscode.CodeLens(r, { title: `$(diff) +${h.added} −${h.removed}`, command: 'claudeIde.openDiff', arguments: [doc.uri.fsPath] }),
        ];
      });
    },
  }));

  // Status bar: pending count + review bar for the active file (extension-API stand-in for the floating bar)
  const mk = (text: string, command: string, tooltip: string, prio: number) => {
    const s = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, prio);
    Object.assign(s, { text, command, tooltip });
    ctx.subscriptions.push(s);
    return s;
  };
  const count = mk('', 'claudeIde.review', 'Review Claude changes', 100);
  const bar = [
    mk('$(check) Accept File ⌘⏎', 'claudeIde.acceptFile', 'Accept all changes in this file', 99),
    mk('$(discard) Reject ⌘⌫', 'claudeIde.rejectFile', 'Reject all changes in this file', 98),
    mk('$(arrow-up)', 'claudeIde.prevHunk', 'Previous change (⌥[)', 97),
    mk('$(arrow-down)', 'claudeIde.nextHunk', 'Next change (⌥])', 96),
    mk('$(arrow-right) Next File', 'claudeIde.nextFile', 'Next changed file (⌥⌘↓)', 95),
  ];

  const activePath = () => {
    const u = vscode.window.activeTextEditor?.document.uri;
    return u && (u.scheme === 'file' || u.scheme === BASELINE_SCHEME) ? u.fsPath : undefined;
  };

  const update = () => {
    const prev = lastPending;
    lastPending = store.pending();
    const n = lastPending.length;
    count.text = `$(sparkle) Claude: ${n} pending`;
    n ? count.show() : count.hide();
    const active = activePath();
    const activeHas = !!active && lastPending.some(p => p.path === active);
    for (const b of bar) activeHas && !native ? b.show() : b.hide();
    void vscode.commands.executeCommand('setContext', 'claudeIde.hasPending', n > 0);
    void vscode.commands.executeCommand('setContext', 'claudeIde.activeHasPending', activeHas);
    tree.badge = n ? { value: n, tooltip: `${n} pending` } : undefined;
    treeChanged.fire();
    lensChanged.fire();
    decoChanged.fire([...prev, ...lastPending].map(p => vscode.Uri.file(p.path)));
    for (const p of lastPending) contentChanged.fire(vscode.Uri.file(p.path).with({ scheme: BASELINE_SCHEME }));
    vscode.window.visibleTextEditors.forEach(decorate);
    pushNative();
  };

  let timer: NodeJS.Timeout | undefined;
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => store.refresh(), 150); };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onFs = (u: vscode.Uri) => { if (store.has(u.fsPath)) soon(); };
  ctx.subscriptions.push(
    tree, watcher, store.onChange(update),
    watcher.onDidChange(onFs), watcher.onDidCreate(onFs), watcher.onDidDelete(onFs),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(decorate)),
    vscode.workspace.onDidChangeTextDocument(e => { if (store.has(e.document.uri.fsPath)) soon(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('claudeIde')) update(); }),
  );

  // ---------- Commands ----------

  const target = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return arg;
    const a = arg as { resourceUri?: vscode.Uri; path?: string; fsPath?: string } | undefined;
    return a?.resourceUri?.fsPath ?? a?.fsPath ?? (typeof a?.path === 'string' && !(a instanceof vscode.Uri) ? a.path : undefined) ?? activePath();
  };
  const saveIfDirty = async (p: string) => {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === p);
    if (doc?.isDirty) await doc.save();
  };

  const openDiff = (p: string) => vscode.commands.executeCommand('vscode.diff',
    vscode.Uri.file(p).with({ scheme: BASELINE_SCHEME }), vscode.Uri.file(p), `${path.basename(p)} (original ↔ Claude)`);

  const open = async (p: string) => {
    const f = store.pending().find(x => x.path === p);
    if (!f) return vscode.window.showTextDocument(vscode.Uri.file(p));
    if (f.status === 'D' || cfg().get('reviewStyle') === 'sideBySide') return openDiff(p);
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(p));
    const h = store.hunks(p, ed.document.getText())[0];
    if (h) reveal(ed, h.start);
  };
  const reveal = (ed: vscode.TextEditor, line: number) => {
    const pos = new vscode.Position(Math.min(line, ed.document.lineCount - 1), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };
  const hunkAtCursor = (p: string) => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return 0;
    const line = ed.selection.active.line;
    const hs = store.hunks(p, ed.document.getText());
    const i = hs.findIndex(h => line >= h.start && line < h.start + Math.max(1, h.added));
    return i >= 0 ? i : Math.max(0, hs.findIndex(h => h.start >= line));
  };
  const stepHunk = (dir: 1 | -1) => {
    const ed = vscode.window.activeTextEditor, p = activePath();
    if (!ed || !p) return;
    const hs = store.hunks(p, ed.document.getText());
    if (!hs.length) return;
    const line = ed.selection.active.line;
    const next = dir > 0 ? hs.find(h => h.start > line) ?? hs[0] : [...hs].reverse().find(h => h.start < line) ?? hs[hs.length - 1];
    reveal(ed, next.start);
  };
  const stepFile = (dir: 1 | -1) => {
    const list = store.pending();
    if (!list.length) return;
    const i = list.findIndex(f => f.path === activePath());
    return open(list[(i + dir + list.length) % list.length].path);
  };
  const afterFileOp = (p: string) => {
    // Keep momentum: jump to the next pending file, like Cursor.
    const next = store.pending()[0];
    if (next && activePath() === p) void open(next.path);
  };

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('claudeIde.open', (p: string) => open(p));
  reg('claudeIde.openDiff', (a: unknown) => { const p = target(a); if (p) return openDiff(p); });
  reg('claudeIde.acceptFile', async (a: unknown) => { const p = target(a); if (!p) return; await saveIfDirty(p); store.accept(p); afterFileOp(p); });
  reg('claudeIde.rejectFile', async (a: unknown) => { const p = target(a); if (!p) return; await saveIfDirty(p); store.reject(p); afterFileOp(p); });
  reg('claudeIde.acceptAll', () => store.acceptAll());
  reg('claudeIde.rejectAll', async () => {
    for (const f of store.pending()) await saveIfDirty(f.path);
    store.rejectAll();
  });
  reg('claudeIde.acceptHunk', async (p?: string, i?: number) => {
    p ??= activePath(); if (!p) return;
    await saveIfDirty(p); store.acceptHunk(p, i ?? hunkAtCursor(p));
  });
  reg('claudeIde.rejectHunk', async (p?: string, i?: number) => {
    p ??= activePath(); if (!p) return;
    await saveIfDirty(p); store.rejectHunk(p, i ?? hunkAtCursor(p));
  });
  reg('claudeIde.nextHunk', () => stepHunk(1));
  reg('claudeIde.prevHunk', () => stepHunk(-1));
  reg('claudeIde.nextFile', () => stepFile(1));
  reg('claudeIde.prevFile', () => stepFile(-1));
  reg('claudeIde.review', async () => {
    const first = store.pending()[0];
    if (first) await open(first.path);
    await vscode.commands.executeCommand('claudeIde.changes.focus');
  });

  update();
  return { open, openDiff };
}

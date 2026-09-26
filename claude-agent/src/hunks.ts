import { diffLines } from 'diff';

export interface Hunk {
  /** 0-based first line of the hunk in the current text. */
  start: number;
  /** Number of added lines in the current text (0 = pure deletion). */
  added: number;
  /** Removed text, exactly as it was in the baseline. */
  removedText: string;
  removed: number;
}

type Part = { value: string; added?: boolean; removed?: boolean; count?: number };
type Seg = { same: string } | { base: string; cur: string };

const lineCount = (s: string) => (s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0);

/** Groups consecutive added/removed parts into change segments. */
function segments(base: string, cur: string): Seg[] {
  const out: Seg[] = [];
  for (const p of diffLines(base, cur) as Part[]) {
    if (!p.added && !p.removed) { out.push({ same: p.value }); continue; }
    let last = out[out.length - 1];
    if (!last || 'same' in last) out.push(last = { base: '', cur: '' });
    if (p.added) last.cur += p.value; else last.base += p.value;
  }
  return out;
}

export function computeHunks(base: string, cur: string): Hunk[] {
  const hunks: Hunk[] = [];
  let line = 0;
  for (const s of segments(base, cur)) {
    if ('same' in s) { line += lineCount(s.same); continue; }
    const added = lineCount(s.cur);
    hunks.push({ start: line, added, removedText: s.base, removed: lineCount(s.base) });
    line += added;
  }
  return hunks;
}

export function diffStats(base: string, cur: string) {
  let add = 0, del = 0;
  for (const h of computeHunks(base, cur)) { add += h.added; del += h.removed; }
  return { add, del };
}

/**
 * Rebuilds text taking hunk `index` from one side and every other hunk from the other.
 * accept → new baseline (hunk index takes current side, rest stays baseline).
 * reject → new current  (hunk index takes baseline side, rest stays current).
 */
export function applyHunk(base: string, cur: string, index: number, mode: 'accept' | 'reject'): string {
  let i = -1, out = '';
  for (const s of segments(base, cur)) {
    if ('same' in s) { out += s.same; continue; }
    const hit = ++i === index;
    out += mode === 'accept' ? (hit ? s.cur : s.base) : (hit ? s.base : s.cur);
  }
  return out;
}

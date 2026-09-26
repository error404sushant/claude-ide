import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({ entryPoints: ['src/hunks.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { computeHunks, applyHunk, diffStats } = await import('data:text/javascript,' + encodeURIComponent(outputFiles[0].text));

const base = 'a\nb\nc\nd\ne\n';
const cur = 'a\nB\nc\nd\ne\nf';

test('hunks and stats', () => {
  const h = computeHunks(base, cur);
  assert.equal(h.length, 2);
  assert.deepEqual([h[0].start, h[0].added, h[0].removedText], [1, 1, 'b\n']);
  assert.deepEqual(diffStats(base, cur), { add: 2, del: 1 });
});

test('accepting one of two hunks leaves only the other pending', () => {
  const newBase = applyHunk(base, cur, 0, 'accept');
  assert.equal(newBase, 'a\nB\nc\nd\ne\n');
  assert.equal(computeHunks(newBase, cur).length, 1);
});

test('rejecting a hunk reverts just that hunk, byte-exact', () => {
  const newCur = applyHunk(base, cur, 1, 'reject');
  assert.equal(newCur, 'a\nB\nc\nd\ne\n');
  assert.equal(applyHunk(base, newCur, 0, 'reject'), base);
});

test('pure insertion and deletion', () => {
  assert.equal(applyHunk('x\n', 'x\ny\n', 0, 'reject'), 'x\n');
  assert.equal(applyHunk('x\ny\n', 'x\n', 0, 'reject'), 'x\ny\n');
  assert.deepEqual(computeHunks('x\ny\n', 'x\n')[0], { start: 1, added: 0, removedText: 'y\n', removed: 1 });
});

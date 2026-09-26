const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const step = (name, ok = true) => console.log(`${ok ? '✔' : '✖'} ${name}`);

exports.run = async () => {
  const { chat, store } = await vscode.extensions.getExtension('local.claude-agent').activate();
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const p = f => path.join(ws, f);
  const orig = Object.fromEntries(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(f => [f, hash(p(f))]));

  const posts = [];
  chat.post = m => posts.push(m);
  chat.view = {}; // no real webview in tests
  chat.ask = async (title, detail, choices) => { posts.push({ type: 'asked', title, detail }); return choices[0]; };
  Object.assign(chat, { model: 'claude-haiku-4-5-20251001', effort: 'low', mode: 'ask' });
  const answer = () => posts.filter(m => m.type === 'assistantText').map(m => m.text).join('\n');

  await chat.send("Using the Edit tool, add the line `// reviewed` as the first line of a.txt, b.txt and c.txt. Create new.txt containing `hi`. Then run exactly this bash command: sed -i '' 's/two/TWO/' d.txt", false);
  const errors = posts.filter(m => m.type === 'done' && m.error);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const pending = store.pending().map(f => path.basename(f.path) + ':' + f.status).sort();
  assert.deepEqual(pending, ['a.txt:M', 'b.txt:M', 'c.txt:M', 'd.txt:M', 'new.txt:A']);
  step('ask mode: 3 edits + new file + sed -i via Bash all staged in the stack');
  assert.ok(posts.some(m => m.type === 'asked' && /sed/.test(m.detail)));
  step('Bash permission prompt shown for sed');
  assert.match(answer(), /BANANA/);
  step('project CLAUDE.md followed (claude_code preset + settingSources)');

  const Store = store.constructor;
  const reloaded = new Store(store.state);
  assert.equal(reloaded.pending().length, 5);
  step('pending stack survives reload (persisted baselines)');

  await vscode.commands.executeCommand('claudeIde.rejectAll');
  for (const [f, h] of Object.entries(orig)) assert.equal(hash(p(f)), h, f);
  assert.ok(!fs.existsSync(p('new.txt')));
  assert.equal(store.pending().length, 0);
  step('Reject All restores byte-identical originals and deletes new file');

  // Hunk-level: two separate hunks, accept one, reject the other.
  store.snapshot(p('d.txt'), 'manual');
  fs.writeFileSync(p('d.txt'), 'ONE\ntwo\nTHREE\n');
  store.settle(); // what PostToolUse does after a real edit
  assert.equal(store.hunks(p('d.txt')).length, 2);
  await vscode.commands.executeCommand('claudeIde.acceptHunk', p('d.txt'), 0);
  assert.equal(store.hunks(p('d.txt')).length, 1);
  step('accepting 1 of 2 hunks leaves only the other pending');
  await vscode.commands.executeCommand('claudeIde.rejectHunk', p('d.txt'), 0);
  assert.equal(fs.readFileSync(p('d.txt'), 'utf8'), 'ONE\ntwo\nthree\n');
  assert.equal(store.pending().length, 0);
  step('rejecting the remaining hunk reverts only it; file leaves the stack');
  fs.writeFileSync(p('d.txt'), 'one\ntwo\nthree\n');

  const sid = chat.sessionId;
  await chat.sendHistory();
  const hist = posts.filter(m => m.type === 'history').pop();
  assert.ok(hist.sessions.some(s => s.id === sid), 'session listed');
  step('history lists this folder\'s session');

  posts.length = 0;
  await chat.send('What exact line did you add to the top of the files earlier? Reply with only that line, then BANANA.', false);
  assert.match(answer(), /\/\/ reviewed/);
  assert.equal(chat.sessionId, sid);
  step('resume continues the same session with prior context');

  chat.mode = 'auto';
  await chat.send('Append a line `END` to the end of a.txt using the Edit tool. Do nothing else.', false);
  assert.match(fs.readFileSync(p('a.txt'), 'utf8'), /END/);
  assert.deepEqual(store.pending().map(f => path.basename(f.path)), ['a.txt']);
  await vscode.commands.executeCommand('claudeIde.rejectFile', p('a.txt'));
  assert.equal(hash(p('a.txt')), orig['a.txt']);
  step('auto mode writes immediately; per-file Undo restores it');

  await chat.send('Using the Edit tool add a line `X` at the end of b.txt. Do nothing else.', false);
  const turn = posts.filter(m => m.type === 'user').pop().turn;
  await vscode.commands.executeCommand('claudeIde.acceptAll');
  assert.ok(store.restoreTo(turn) >= 1);
  assert.equal(hash(p('b.txt')), orig['b.txt']);
  step('checkpoint: Restore to here undoes even accepted changes from that turn on');

  const running = chat.send('Write a 2000 word essay into essay.txt using the Write tool, one paragraph at a time with separate Edit calls.', false);
  await new Promise(r => setTimeout(r, 8000));
  chat.stop();
  await running;
  store.pending(); // must not throw
  assert.ok(posts.some(m => m.type === 'done'));
  await vscode.commands.executeCommand('claudeIde.rejectAll');
  assert.ok(!fs.existsSync(p('essay.txt')));
  step('Stop halts mid-turn; baseline store still consistent');

  // Ask before each edit: rejecting leaves disk untouched; accepting writes and is final (not staged).
  chat.mode = 'askBeforeEach';
  posts.length = 0;
  chat.ask = async (title, detail, choices) => { posts.push({ type: 'asked', title }); return /c\.txt/.test(title) ? 'Reject' : choices[0]; };
  await chat.send('Use the Write tool to overwrite b.txt with the content `Y` and then c.txt with the content `Z`. If a write is rejected, do not retry it.', false);
  assert.ok(posts.some(m => m.type === 'asked' && /b\.txt/.test(m.title)), JSON.stringify(posts.filter(m => ['tool', 'asked', 'toolResult', 'done'].includes(m.type))).slice(0, 3000));
  assert.match(fs.readFileSync(p('b.txt'), 'utf8'), /Y/);
  assert.equal(hash(p('c.txt')), orig['c.txt']);
  assert.equal(store.pending().length, 0);
  step('ask-before-each: approved edit written, rejected edit never touches disk');
  fs.writeFileSync(p('b.txt'), 'file b\n');

  chat.mode = 'plan';
  posts.length = 0;
  chat.ask = async (title, detail, choices) => (title === 'Plan ready' ? 'Keep planning' : choices[0]);
  await chat.send('Replace the content of a.txt with `planned`. Present your plan.', false);
  assert.equal(hash(p('a.txt')), orig['a.txt']);
  step('plan mode: nothing written while planning');

  chat.ask = async (title, detail, choices) => choices[0];
  await chat.send('The plan is approved, go ahead.', false);
  assert.match(fs.readFileSync(p('a.txt'), 'utf8'), /planned/);
  assert.equal(chat.mode, 'ask');
  assert.deepEqual(store.pending().map(f => path.basename(f.path)), ['a.txt'], JSON.stringify(store.pending()));
  step('approving the plan switches to Ask mode and the edit lands in the review stack');

  // AskUserQuestion: Claude asks, the panel answers (here: pick the second option), Claude uses the answer.
  chat.mode = 'ask';
  posts.length = 0;
  chat.post = m => {
    posts.push(m);
    if (m.type === 'question') {
      const q = m.questions[0];
      setTimeout(() => chat.onMessage({ type: 'permission', id: m.id, choice: JSON.stringify({ [q.question]: q.options[1].label }) }), 100);
    }
  };
  await chat.send('Use the AskUserQuestion tool to ask me which color theme I prefer, with exactly the options Light and Dark (in that order). Then reply with only the chosen option name.', false);
  const q = posts.find(m => m.type === 'question');
  assert.ok(q, 'question card shown');
  assert.match(answer(), new RegExp(q.questions[0].options[1].label, 'i'));
  step('AskUserQuestion: options shown, chosen answer returned to Claude');
};

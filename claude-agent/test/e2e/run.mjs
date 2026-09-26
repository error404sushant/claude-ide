// End-to-end: launches VS Code with the extension and runs suite.cjs against a temp workspace (real Claude calls, Haiku).
import { runTests } from '@vscode/test-electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.resolve(import.meta.dirname, '../..');
// Opened through the /tmp → /private/tmp symlink on purpose: the review UI must still match Claude's real paths.
const ws = fs.mkdtempSync('/tmp/claudeide');
for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(ws, `${f}.txt`), `file ${f}\n`);
fs.writeFileSync(path.join(ws, 'd.txt'), 'one\ntwo\nthree\n');
fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'Always end every reply with the exact word BANANA.\n');

await runTests({
  version: process.env.VSCODE_VERSION ?? 'stable',
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'test/e2e/suite.cjs'),
  launchArgs: [ws, '--disable-extensions', '--skip-welcome'],
});

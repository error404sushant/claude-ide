#!/usr/bin/env node
// Launches the built Claude IDE on a sample project and checks that it starts cleanly:
// the window opens, the Claude panel loads, and there is no "corrupt installation" warning.
// Saves a screenshot to smoke/. Usage: node scripts/smoke-test.mjs [--arch x64|arm64] [--app <path to executable>]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const arch = opt('--arch') ?? process.arch;
const platform = process.platform;
const out = path.join(ROOT, `VSCode-${platform}-${arch}`);
const app = opt('--app') ?? (platform === 'darwin' ? path.join(out, 'Claude IDE.app', 'Contents', 'MacOS', 'Claude IDE')
  : platform === 'win32' ? path.join(out, 'Claude IDE.exe') : path.join(out, 'claude-ide'));
if (!fs.existsSync(app)) { console.error(`App not found: ${app}`); process.exit(1); }

const PORT = 9337;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ide-smoke-'));
const workspace = path.join(tmp, 'sample');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'app.js'), "export const greet = name => `Hello, ${name}!`;\n");
const child = spawn(app, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(tmp, 'data')}`, `--extensions-dir=${path.join(tmp, 'ext')}`,
  '--disable-workspace-trust', '--skip-welcome', workspace, path.join(workspace, 'app.js')], { stdio: 'ignore', detached: platform !== 'win32' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function stop() {
  try { platform === 'win32' ? execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }) : process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
}
async function main() {
  let page;
  for (let i = 0; i < 90 && !page; i++) {
    await sleep(2000);
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page' && !t.url.startsWith('devtools')); } catch { /* not up yet */ }
  }
  if (!page) throw new Error('The app window did not open within 3 minutes.');
  await sleep(20000);                                   // let extensions activate and the Claude panel load

  const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
  const call = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise(r => (ws.onopen = r));
  const { result } = await call('Runtime.evaluate', { returnByValue: true, expression: `({
    title: document.title,
    claudePanel: !!document.querySelector('iframe[src*="extensionId=local.claude-agent"]'),
    theme: getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-button-background').trim(),
    notifications: [...document.querySelectorAll('.notification-list-item-message')].map(n => n.innerText),
  })` });
  const state = result.result.value;
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(ROOT, 'smoke'), { recursive: true });
  const file = path.join(ROOT, 'smoke', `claude-ide-${platform}-${arch}.png`);
  fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  ws.close();

  console.log(JSON.stringify(state, null, 2));
  console.log(`Screenshot: ${file}`);
  const problems = [];
  if (!state.claudePanel) problems.push('the Claude panel did not load');
  if (state.notifications.some(n => /corrupt/i.test(n))) problems.push('"installation appears to be corrupt" warning');
  if (problems.length) throw new Error(`Launch test failed: ${problems.join('; ')}`);
  console.log('Launch test passed.');
}
main().then(() => { stop(); process.exit(0); }, e => { console.error(e.message); stop(); process.exit(1); });

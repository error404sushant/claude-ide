// node render.mjs stills 1.5,4,8.3,...   |   node render.mjs video
import { spawn } from 'child_process';
import fs from 'fs';
const CHROME = process.env.CHROME;
const [, , mode, list] = process.argv;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1920,1080', '--allow-file-access-from-files', '--remote-debugging-port=9555', '--user-data-dir=/tmp/brag-chrome', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch('http://127.0.0.1:9555/json')).json(); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const call = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => (ws.onopen = r));
await call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await call('Page.enable');
await call('Page.navigate', { url: 'file://' + process.cwd() + '/scene.html' });
await new Promise(r => setTimeout(r, 1500));
console.log(await call('Runtime.evaluate', { expression: 'window.ready', awaitPromise: true, returnByValue: true }).then(r => r.result.result.value));
const frame = async (t, fmt = 'jpeg') => {
  await call('Runtime.evaluate', { expression: `render(${t})` });
  const r = await call('Page.captureScreenshot', { format: fmt, quality: 94, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
  return Buffer.from(r.result.data, 'base64');
};
if (mode === 'stills') {
  for (const t of list.split(',')) fs.writeFileSync(`still-${t}.jpg`, await frame(+t));
} else {
  const FPS = 30, N = Math.round(21 * FPS);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', 'video-noaudio.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < N; i++) {
    const buf = await frame(i / FPS);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 90 === 0) console.log('frame', i, '/', N);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('video-noaudio.mp4 written');
}
chrome.kill(); process.exit(0);

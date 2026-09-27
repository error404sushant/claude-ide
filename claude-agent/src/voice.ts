import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFile, spawn } from 'child_process';

// Local, offline dictation: ffmpeg records the mic, whisper.cpp transcribes. (Electron has no Web Speech API.)
const isWin = process.platform === 'win32';
const BIN_DIRS = isWin ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const pathDirs = () => (process.env[Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'] ?? '').split(path.delimiter).filter(Boolean);
const which = (name: string) => [...BIN_DIRS, ...pathDirs()].map(d => path.join(d, isWin ? `${name}.exe` : name)).find(p => fs.existsSync(p));
const cfg = () => vscode.workspace.getConfiguration('claudeIde');

let rec: { proc: ChildProcess; file: string; stderr: string } | undefined;

/** ffmpeg input arguments for the microphone on this OS (macOS avfoundation, Windows dshow, Linux PulseAudio). */
function micInput(ffmpeg: string): Promise<{ args: string[]; name: string }> {
  const configured = cfg().get<string>('micDevice');
  if (process.platform === 'linux') return Promise.resolve({ args: ['-f', 'pulse', '-i', configured || 'default'], name: configured || 'default' });
  const listArgs = isWin ? ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'] : ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
  return new Promise(res => execFile(ffmpeg, listArgs, (_e, _o, err) => {
    const names = isWin
      ? [...err.matchAll(/"([^"]+)"\s*\(audio\)/g)].map(m => m[1])
      : [...(err.split(/audio devices:/i)[1] ?? '').matchAll(/\[(\d+)\] (.+)/g)].map(m => m[2].trim());
    // Prefer the built-in mic over virtual devices (Teams, iPhone continuity…).
    const name = configured || names.find(n => /macbook|built-in|internal/i.test(n)) || names.find(n => /microphone|mic/i.test(n) && !/iphone/i.test(n)) || names[0] || 'default';
    res({ args: isWin ? ['-f', 'dshow', '-i', `audio=${name}`] : ['-f', 'avfoundation', '-i', `:${name}`], name });
  }));
}

export async function startRecording(): Promise<string | undefined> {
  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) return `Voice input needs ffmpeg: ${isWin ? 'winget install ffmpeg' : process.platform === 'darwin' ? 'brew install ffmpeg' : 'install ffmpeg with your package manager'}`;
  if (rec) return;
  const file = path.join(os.tmpdir(), `claude-voice-${Date.now()}.wav`);
  const mic = await micInput(ffmpeg);
  const proc = spawn(ffmpeg, ['-loglevel', 'error', '-y', ...mic.args, '-ar', '16000', '-ac', '1', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  rec = { proc, file, stderr: '' };
  const r = rec;
  proc.stderr?.on('data', d => { r.stderr += d; });
  // ffmpeg quitting on its own means the mic could not be opened.
  const failed = await new Promise<boolean>(res => { proc.once('exit', () => res(true)); setTimeout(() => res(false), 700); });
  if (failed) { rec = undefined; return `Could not open microphone "${mic.name}": ${r.stderr.trim() || 'ffmpeg exited'}`; }
}

/** Stops recording and resolves with the transcript. */
export function stopRecording(): Promise<string> {
  const r = rec;
  rec = undefined;
  if (!r) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    r.proc.once('exit', () => {
      const whisper = which('whisper-cli');
      const model = cfg().get<string>('whisperModel') || path.join(os.homedir(), '.claude-ide/whisper/ggml-base.en.bin');
      if (!whisper) return reject(new Error(`Voice input needs whisper.cpp (whisper-cli): ${process.platform === 'darwin' ? 'brew install whisper-cpp' : 'see github.com/ggml-org/whisper.cpp/releases'}`));
      if (!fs.existsSync(model)) return reject(new Error(`Whisper model missing at ${model}. Download ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp`));
      if (!fs.existsSync(r.file)) return reject(new Error('No audio was recorded. Allow microphone access for Claude IDE in System Settings → Privacy & Security → Microphone.'));
      execFile(whisper, ['-m', model, '-f', r.file, '-nt', '-np'], { timeout: 120000 }, (err, out) => {
        fs.rmSync(r.file, { force: true });
        if (err) return reject(err);
        const text = out.replace(/\[BLANK_AUDIO\]|\[silence\]|\(silence\)/gi, '').replace(/\s+/g, ' ').trim();
        if (!text) return reject(new Error('Heard only silence. If you spoke, allow microphone access for Claude IDE in System Settings → Privacy & Security → Microphone, or set claudeIde.micDevice.'));
        resolve(text);
      });
    });
    r.proc.stdin?.write('q'); // ffmpeg finalizes the wav header on 'q'
    setTimeout(() => r.proc.kill('SIGINT'), 1500);
  });
}

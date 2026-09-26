import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFile, spawn } from 'child_process';

// Local, offline dictation: ffmpeg records the mic, whisper.cpp transcribes. (Electron has no Web Speech API.)
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const which = (name: string) => BIN_DIRS.map(d => path.join(d, name)).find(p => fs.existsSync(p));
const cfg = () => vscode.workspace.getConfiguration('claudeIde');

let rec: { proc: ChildProcess; file: string; stderr: string } | undefined;

function pickMic(ffmpeg: string): Promise<string> {
  const configured = cfg().get<string>('micDevice');
  if (configured) return Promise.resolve(configured);
  return new Promise(res => execFile(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], (_e, _o, err) => {
    const audio = err.split(/audio devices:/i)[1] ?? '';
    const names = [...audio.matchAll(/\[(\d+)\] (.+)/g)].map(m => m[2].trim());
    // Prefer the built-in mic over virtual devices (Teams, iPhone continuity…).
    res(names.find(n => /macbook|built-in/i.test(n)) ?? names.find(n => /microphone/i.test(n) && !/iphone/i.test(n)) ?? names[0] ?? 'default');
  }));
}

export async function startRecording(): Promise<string | undefined> {
  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) return 'Voice input needs ffmpeg: brew install ffmpeg';
  if (rec) return;
  const file = path.join(os.tmpdir(), `claude-voice-${Date.now()}.wav`);
  const mic = await pickMic(ffmpeg);
  const proc = spawn(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', `:${mic}`, '-ar', '16000', '-ac', '1', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  rec = { proc, file, stderr: '' };
  const r = rec;
  proc.stderr?.on('data', d => { r.stderr += d; });
  // ffmpeg quitting on its own means the mic could not be opened.
  const failed = await new Promise<boolean>(res => { proc.once('exit', () => res(true)); setTimeout(() => res(false), 700); });
  if (failed) { rec = undefined; return `Could not open microphone "${mic}": ${r.stderr.trim() || 'ffmpeg exited'}`; }
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
      if (!whisper) return reject(new Error('Voice input needs whisper.cpp: brew install whisper-cpp'));
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

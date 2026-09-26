"""Soundtrack for the Claude IDE brag video: 100 BPM, D major, warm pad + pluck + soft drums, with SFX in key.
Scene cuts land on beats (0.6 s): 2.4, 5.4, 11.4, 14.4, 17.4. Writes soundtrack.wav (21 s, 44.1 kHz stereo)."""
import numpy as np, wave

SR, DUR, BEAT = 44100, 21.0, 0.6
N = int(SR * DUR)
t_all = np.arange(N) / SR
L = np.zeros(N); R = np.zeros(N); VERB = np.zeros(N)
rng = np.random.default_rng(7)
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)            # MIDI → Hz

def add(sig, start, gain=1.0, pan=0.0, verb=0.0):
    i = int(start * SR)
    if i >= N: return
    sig = sig[: N - i]
    l, r = gain * np.cos((pan + 1) * np.pi / 4), gain * np.sin((pan + 1) * np.pi / 4)
    L[i:i + len(sig)] += sig * l * 1.414; R[i:i + len(sig)] += sig * r * 1.414; VERB[i:i + len(sig)] += sig * verb

def env(n, a, r, hold=None):
    e = np.ones(n); na = max(1, int(a * SR)); e[:na] = np.linspace(0, 1, na)
    nr = max(1, int(r * SR)); e[-nr:] *= np.linspace(1, 0, nr)
    return e

def onepole(x, cutoff):                                    # gentle low-pass
    a = np.exp(-2 * np.pi * cutoff / SR); y = np.empty_like(x); acc = 0.0
    for i, v in enumerate(x): acc = (1 - a) * v + a * acc; y[i] = acc
    return y

def pad(notes, start, dur, gain):
    n = int(dur * SR); tt = np.arange(n) / SR; sig = np.zeros(n)
    for m in notes:
        f = hz(m)
        for d in (-0.0018, 0, 0.0021):
            sig += np.sin(2 * np.pi * f * (1 + d) * tt) + 0.25 * np.sin(4 * np.pi * f * (1 + d) * tt)
    sig = onepole(sig / (len(notes) * 3), 1400) * env(n, 0.9, 1.2)
    add(sig, start, gain, 0, 0.6)

def pluck(m, start, gain, pan=0.0, decay=0.28):
    n = int(1.2 * SR); tt = np.arange(n) / SR; f = hz(m)
    sig = (np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(4 * np.pi * f * tt) + 0.1 * np.sin(6 * np.pi * f * tt)) * np.exp(-tt / decay)
    sig[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
    add(sig, start, gain, pan, 0.35)

def kick(start, gain):
    n = int(0.45 * SR); tt = np.arange(n) / SR
    f = 45 + 75 * np.exp(-tt / 0.035); ph = 2 * np.pi * np.cumsum(f) / SR
    add(np.sin(ph) * np.exp(-tt / 0.16), start, gain)

def hat(start, gain, pan):
    n = int(0.09 * SR); x = rng.standard_normal(n); x = x - onepole(x, 6000)
    add(x * np.exp(-np.arange(n) / SR / 0.025), start, gain, pan, 0.1)

def bass(m, start, dur, gain):
    n = int(dur * SR); tt = np.arange(n) / SR
    sig = np.tanh(1.6 * np.sin(2 * np.pi * hz(m) * tt)) * env(n, 0.01, 0.12)
    add(onepole(sig, 500), start, gain)

def whoosh(end, gain, length=0.45):
    n = int(length * SR); x = rng.standard_normal(n)
    x = onepole(x, 2500) - onepole(x, 300)
    add(x * np.linspace(0, 1, n) ** 2.2 * env(n, 0.01, 0.05), end - length, gain, 0, 0.5)

def chime(notes, start, gain):
    for j, m in enumerate(notes):
        n = int(2.0 * SR); tt = np.arange(n) / SR; f = hz(m)
        sig = (np.sin(2 * np.pi * f * tt) + 0.4 * np.sin(2 * np.pi * f * 2.76 * tt) * np.exp(-tt / 0.15)) * np.exp(-tt / 0.7)
        add(sig, start + j * 0.06, gain, (-0.3 + 0.6 * j), 0.6)

def tick(start, gain):
    n = int(0.05 * SR); tt = np.arange(n) / SR
    add(np.sin(2 * np.pi * 2349 * tt) * np.exp(-tt / 0.008), start, gain, 0.1, 0.2)

# --- Harmony: D major. Chords as MIDI notes.
Dmaj9 = [50, 57, 61, 64, 66]; Bm7 = [47, 54, 57, 62, 66]; Gmaj7 = [43, 55, 59, 62, 66]; A6 = [45, 52, 57, 61, 66]; Dadd9 = [50, 57, 62, 64, 66, 69]
pad(Dmaj9, 0.0, 2.6, 0.55)                                  # hook: pad alone
whoosh(2.4, 0.18, 0.9)                                      # riser into the reveal
sections = [(2.4, Dmaj9, 50), (5.4, Bm7, 47), (8.4, Gmaj7, 43), (11.4, A6, 45), (14.4, Bm7, 47), (17.4, Dadd9, 50)]
for i, (start, chord, root) in enumerate(sections):
    end = sections[i + 1][0] if i + 1 < len(sections) else DUR
    pad(chord, start, end - start + 0.8, 0.42)
    b = start
    while b < min(end, 19.8) - 0.01:
        k = int(round((b - 2.4) / BEAT))
        kick(b, 0.55 if k % 4 == 0 else 0.4)
        hat(b + BEAT / 2, 0.05, 0.3 if k % 2 else -0.3)
        bass(root - 12 + (7 if k % 4 == 3 else 0), b, BEAT * 0.9, 0.22)
        # 8th-note arpeggio from the chord's upper notes
        up = [n + 12 for n in chord[1:]]
        pluck(up[(2 * k) % len(up)], b, 0.12, -0.35)
        pluck(up[(2 * k + 2) % len(up)], b + BEAT / 2, 0.09, 0.35)
        b += BEAT

# --- SFX, all in D major
for j, m in enumerate([74, 76, 78, 81, 83, 86, 88]): pluck(m, 2.5 + j * 0.09, 0.08, -0.4 + j * 0.13, 0.12)    # reveal tiles
tick(8.6, 0.22); chime([81, 86], 8.66, 0.16)               # cursor click → Accept
for tt, m in [(12.35, 78), (12.6, 81), (12.85, 86)]: pluck(m, tt, 0.13, 0.25, 0.1)                          # chips land
for cut in (5.4, 11.4, 14.4, 17.4): whoosh(cut, 0.09)
for j, m in enumerate([74, 76, 78, 81, 83, 86, 88]): pluck(m, 17.5 + j * 0.08, 0.07, -0.4 + j * 0.13, 0.12)  # outro tiles
chime([74, 78, 81, 86], 19.2, 0.12)

# --- Reverb: FFT convolution with decaying noise (separate L/R tails for width)
def tail(seed):
    r = np.random.default_rng(seed); n = int(1.6 * SR); tt = np.arange(n) / SR
    return onepole(r.standard_normal(n), 3500) * np.exp(-tt / 0.45) * 0.05
def conv(x, h):
    m = len(x) + len(h); F = 1 << (m - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, F) * np.fft.rfft(h, F), F)[:len(x)]
L += conv(VERB, tail(1)); R += conv(VERB, tail(2))

# --- Master: fade, soft clip, normalize to -1 dBFS
fade = np.ones(N); nf = int(1.4 * SR); fade[-nf:] = np.linspace(1, 0, nf) ** 1.5; fade[: int(0.03 * SR)] = np.linspace(0, 1, int(0.03 * SR))
st = np.stack([L, R], 1) * fade[:, None]
st = np.tanh(st / (np.abs(st).max() + 1e-9) * 1.3) ; st = st / np.abs(st).max() * 10 ** (-1 / 20)
with wave.open('soundtrack.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype('<i2').tobytes())
print('soundtrack.wav', DUR, 's')

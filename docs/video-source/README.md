# Demo video source

The demo video is rendered from real Claude IDE screenshots:

- `scene.html` draws every frame as a function of time (`render(t)`), using the full-resolution screenshots (2880×1800) from `docs/images` placed next to it.
- `render.mjs` loads the scene in headless Chrome, captures 630 frames (21 s at 30 fps) and pipes them to ffmpeg.
- `music.py` synthesizes the soundtrack (100 BPM, D major) with the sound effects timed to the on-screen actions.
- `brag-plan.md` is the storyboard.

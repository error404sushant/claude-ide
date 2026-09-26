# Claude IDE — brag plan

**What it is:** a VS Code (Code-OSS) fork with the real Claude Code agent built in, where every change Claude makes waits for your review, inline, like Cursor.
**For:** developers who use Claude Code and want to see and approve each line it writes without leaving the editor.
**Sets it apart:** the agent works freely; its edits land as a review stack with old code shown in red inside the file, per-change Accept/Reject, and a floating review bar. Files, folders and screenshots drop straight into chat; Claude asks multiple-choice questions you can answer or override.
**Most impressive claim:** "Claude just edited 2 files. You decide every line."
**Visual hook:** a bold two-line statement on warm charcoal; the second line lands in terracotta.
**Real UI shown:** a live JavaScript change (cart.js, discount codes + rounding fix) with the old `return` in red above its replacement, then Accept → next file.
**Tone:** `polished` with warmth — confident, clean, no jokes forced.
**Share caption:** "I built my own editor: Claude Code inside VS Code, where every line it writes waits for my ✓."

## Identity
Warm charcoal `#1A1614` → `#0F0C0B`, cream text `#F3E9E0`, muted `#A99A8D`, terracotta accent `#E8895A` / `#D9774B`, system font (SF Pro) + SF Mono. Logo: a "C" made of seven terracotta tiles.

## Storyboard (100 BPM, beat = 0.6s; cuts on beats) — 21.0s
| # | Time | Scene | On screen | Motion | Sound |
|---|---|---|---|---|---|
| 1 | 0.0–2.4 | Hook | "Claude just edited 2 files." → "You decide every line." (accent) | lines rise in, staggered | pad swells, soft riser |
| 2 | 2.4–5.4 | Reveal | Tile "C" assembles + **Claude IDE** + "VS Code with the real Claude Code agent built in"; app window rises in | tiles pop on beats, window slides up | beat drops in, tile ticks |
| 3 | 5.4–11.4 | Inline review | Real screenshot of cart.js change; caption "Every change waits for you." / "Old code in red. Accept or reject each change." | slow zoom to the `total()` hunk, cursor glides to **Accept**, click → accepted state | click + warm chime |
| 4 | 11.4–14.4 | Drag & drop | Chips fly from Explorer into the composer; caption "Drag in files, folders and screenshots." | chip arcs, lands, composer zooms | soft pops on landing |
| 5 | 14.4–17.4 | Questions | Real question card (node:test ●, Discount codes ☑, Rounding ☑); caption "Claude asks. Pick an option or type your own." | card slides up, gentle pan | whoosh |
| 6 | 17.4–21.0 | Outro | Logo + **Claude IDE** · "Inline review · Voice input · Checkpoints · Plan mode" · github.com/error404sushant/claude-ide · "by error404sushant" | settle, hold | final chord, fade |

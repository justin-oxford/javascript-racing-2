# JavaScript Racing

Top-down browser racing game. A TypeScript rebuild of the 2019 v0.16 canvas game.
Project state lives on the Trello board "Javascript Racing".

## Run

```bash
npm install
npm run dev      # play at http://localhost:5173
npm test         # steps the sim headless in Node
npm run build    # typecheck + production build to dist/
```

Controls: WASD / arrows drive, Z / Space / S brake (hold at a standstill to reverse), R resets to the pits,
K toggles the debug overlay (mask, traced walls, timing lines, racing line, grid, each wheel's surface).
In dev, T opens the tuning panel: a slider for every value in `config/physics.json`, surfaces and rules,
live on the running car, with telemetry. **Save to /config** writes the files.

`?track=<id>` opens a specific track (e.g. `?track=indiana`, the test fixture).

## Tracks

Tracks are authored per **SYS — Track authoring spec** (Trello): 2560x1440, ~10.8 px/m.
The first non-fixture track in `tracks/` is the default. Indiana is a test fixture only.

Each track is a folder, `tracks/<id>/`. Only `mask.png` is required to drive it:

| File | What |
| --- | --- |
| `track.json` | Optional until lines are placed in the editor. Name, scale, timing lines, racing line, grid, spawn. Mask pixels. |
| `mask.png` | Gameplay mask, same size as the background, flat palette colours (see `config/surfaces.json`). |
| `mask-draft.png` | Auto-generated starting point (`npm run draft-mask`). Used until `mask.png` exists. |
| `background.png` | Optional art. Without it the mask is drawn in muted blockout colours. |
| `overhead.png` | Optional. Drawn above cars (bridges, canopy). |

Paths in `track.json` are relative to the track folder; a leading `/` means the site root (Indiana's background is `/assets/BGs/indiana.jpg`).

Mask palette: `#808080` asphalt, `#FF0000` kerb, `#00FF00` grass, `#FFFF00` gravel, `#000000` wall,
`#FF00FF` tyre barrier, `#0000FF` pit lane, `#00FFFF` pit box, `#FFFFFF` out of bounds.
Off-palette pixels are snapped to the nearest colour on load.

In `npm run dev`, saving `mask.png` (or `background.png`) in an image editor updates the running game without a page reload.
A brand-new track folder reloads the page once so it joins the track list.

## Physics

`src/sim` runs in metres and seconds. One Planck (Box2D) body per car; per-wheel grip is capped
(base x tyre-wear curve x surface x downforce x load). Car stats are team x spec x setup ratios
(`config/teams.json`, `config/specs.json`) on top of the absolute values in `config/physics.json`.
Planck is only a cache: walls are built once per mask and car bodies are rebuilt from plain state
every tick, so a world rebuilt from any snapshot replays exactly.

Track editor (dev only): open http://localhost:5173/?edit=1. Timing lines, racing line, grid, spawn; Save writes `track.json`.

## Layout

| Path | What |
| --- | --- |
| `src/sim` | Pure simulation: physics, cars, timing, race rules, AI. No DOM, no clock, no unseeded randomness. Runs in browser and Node. |
| `src/client` | Rendering, HUD, input, audio, dev tools. |
| `src/server` | Multiplayer server (card 07). |
| `tracks` | One folder per track (see Tracks above). |
| `config` | Car / team / spec / setup tuning JSON. |
| `tools` | Offline scripts. |
| `public/assets` | Sprites, backgrounds, fonts (from v0.16). |

The sim ticks at a fixed 60 Hz; rendering runs on `requestAnimationFrame` and interpolates between the last two sim states.

Purity of `src/sim` is enforced twice: `tsconfig.sim.json` typechecks it without DOM or Node types, and `src/sim/sim.test.ts` fails on clock, randomness or browser globals.

## Deploy

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`.

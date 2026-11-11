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

Controls: WASD / arrows drive, Z / Space / S brake, R resets to the pits, K toggles the debug overlay
(mask, traced walls, timing lines, racing line, grid, each wheel's surface).

## Tracks

Each track is a folder, `tracks/<id>/`:

| File | What |
| --- | --- |
| `track.json` | Name, scale (`pxPerMeter`), file paths, timing lines, racing line, grid, spawn. Mask pixels. |
| `mask.png` | Gameplay mask, same size as the background, flat palette colours (see `config/surfaces.json`). |
| `mask-draft.png` | Auto-generated starting point (`npm run draft-mask`). Used until `mask.png` exists. |
| `overhead.png` | Optional. Drawn above cars (bridges, canopy). |

The background lives in `public/assets/BGs/` and is referenced from `track.json`.

Mask palette: `#808080` asphalt, `#FF0000` kerb, `#00FF00` grass, `#FFFF00` gravel, `#000000` wall,
`#FF00FF` tyre barrier, `#0000FF` pit lane, `#00FFFF` pit box, `#FFFFFF` out of bounds.
Off-palette pixels are snapped to the nearest colour on load.

In `npm run dev`, saving `mask.png` in an image editor updates the running game without a page reload.

Track editor (dev only): open http://localhost:5173/?edit=1. Timing lines, racing line, grid, spawn; Save writes `track.json`.

## Layout

| Path | What |
| --- | --- |
| `src/sim` | Pure simulation: physics, cars, timing, race rules, AI. No DOM, no clock, no unseeded randomness. Runs in browser and Node. |
| `src/client` | Rendering, HUD, input, audio, dev tools. |
| `src/server` | Multiplayer server (card 07). |
| `tracks` | One JSON file per track. |
| `config` | Car / team / spec / setup tuning JSON. |
| `tools` | Offline scripts. |
| `public/assets` | Sprites, backgrounds, fonts (from v0.16). |

The sim ticks at a fixed 60 Hz; rendering runs on `requestAnimationFrame` and interpolates between the last two sim states.

Purity of `src/sim` is enforced twice: `tsconfig.sim.json` typechecks it without DOM or Node types, and `src/sim/sim.test.ts` fails on clock, randomness or browser globals.

## Deploy

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`.

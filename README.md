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

Controls: WASD / arrows drive, Z / Space / S brake, R resets to the pits, K toggles the debug overlay.

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

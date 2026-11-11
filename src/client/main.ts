import { createWorld, resetCar, setCarBuild, step, TICK_HZ, type InputSource, type SimContext, type WorldState } from '../sim';
import { drawMask, drawTrackData, drawWalls, drawWheels } from './debug-draw';
import { KeyboardInput } from './input/keyboard';
import { startLoop } from './loop';
import { Renderer, type CarLook } from './render';
import {
  chooseTrackId,
  getTrackJsonStub,
  loadBackground,
  loadMask,
  loadOverhead,
  loadTeamSprites,
  physics,
  rules,
  simContext,
  surfaces,
  surfacesConfig,
  type MaskState,
} from './track-loader';
import './style.css';

async function main(): Promise<void> {
  const trackId = chooseTrackId();
  const stub = getTrackJsonStub(trackId);
  let mask: MaskState = await loadMask(stub);
  const json = mask.track.json; // the stub, completed in place: the editor edits this same object
  const [background, overhead0, sprites] = await Promise.all([loadBackground(json), loadOverhead(json), loadTeamSprites()]);
  let overhead = overhead0;
  let hasArt = !!background;
  let ctx: SimContext = simContext(mask);
  document.title = `${json.name} · JavaScript Racing`;

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new Renderer(canvas, mask.track.mask.width, mask.track.mask.height, background ?? mask.blockout);

  const keyboard = new KeyboardInput();
  const drivers: InputSource[] = [keyboard];

  let prev: WorldState = createWorld(ctx, drivers.length);
  let curr: WorldState = prev;
  let debug = false;
  let fps = TICK_HZ; // display smoothing starts at the expected rate, not 0

  keyboard.onAction((a) => {
    if (a.type === 'reset') {
      curr = resetCar(curr, 0, json.spawn, ctx);
      prev = curr;
    } else if (a.type === 'toggleDebug') {
      debug = !debug;
    }
    // gridSlot: no grid until card 06.
  });

  // Dev-only tools. Dynamic imports keep them out of the production bundle.
  const editor = import.meta.env.DEV && new URLSearchParams(location.search).has('edit')
    ? new (await import('./editor/editor')).TrackEditor(renderer, json)
    : undefined;
  const tuning = import.meta.env.DEV
    ? new (await import('./tuning/panel')).TuningPanel({
        physics,
        surfacesConfig,
        rules,
        onBuildChange: (build) => {
          curr = setCarBuild(curr, 0, build);
          prev = setCarBuild(prev, 0, build);
        },
      })
    : undefined;

  if (import.meta.env.DEV) {
    Object.assign(window, {
      __game: {
        world: () => curr,
        surfaceNames: () => curr.cars.map((c) => c.wheels.map((w) => surfaces[w.surface]!.id)),
        mask: () => mask,
        ctx: () => ctx,
        editor,
        tuning,
      },
    });
  }

  // Hot reload: Justin saves mask.png / background.png in an image editor, the running game picks it up.
  if (import.meta.hot) {
    import.meta.hot.on('track:file-changed', async ({ id, file }: { id: string; file: string }) => {
      if (id !== json.id) return;
      const f = json.files;
      try {
        if (file === f.mask || (file === f.maskDraft && mask.file !== f.mask)) {
          mask = await loadMask(json);
          ctx = { ...ctx, track: mask.track, walls: mask.walls };
          if (!hasArt) renderer.background = mask.blockout;
          console.info(`[track] hot-reloaded ${id}/${mask.file}`);
        } else if (file === f.background) {
          const bg = await loadBackground(json);
          hasArt = !!bg;
          renderer.background = bg ?? mask.blockout;
        } else if (file === f.overhead) {
          overhead = await loadOverhead(json);
        }
      } catch (e) {
        console.error(`[track] reload of ${file} failed`, e);
      }
    });
  }

  const look: CarLook = {
    get pxPerMeter() { return json.pxPerMeter; },
    get lengthM() { return physics.car.lengthM; },
    get widthM() { return physics.car.widthM; },
    sprite: (car) => sprites.get(car.build.team),
  };
  const surfaceName = (car: WorldState['cars'][number], w: 0 | 1 | 2 | 3) => surfaces[car.wheels[w].surface]?.id ?? '?';

  startLoop({
    tick() {
      const inputs = drivers.map((d) => d.read(curr.tick));
      prev = curr;
      curr = step(curr, inputs, ctx);
      for (const e of curr.events) {
        if (e.type === 'outOfBounds')
          console.warn(`[mask bug] car ${e.car} reached out-of-bounds at (${e.x.toFixed(1)}, ${e.y.toFixed(1)}) px in ${mask.file}; reset to spawn`);
      }
    },
    render(alpha, frameSeconds) {
      if (frameSeconds > 0) fps += (1 / frameSeconds - fps) * 0.05;
      const lw = renderer.trackPxPerCssPx();
      const car = curr.cars[0];
      const text = debug && car
        ? `${json.name}${json.fixture ? ' (test fixture)' : ''}  tick ${curr.tick} @ ${TICK_HZ} Hz   fps ${fps.toFixed(0)}\n` +
          `kph ${(car.speed * 3.6).toFixed(0)}${car.inPitLane ? '  PIT LIMITER' : ''}${car.inPitBox ? '  PIT BOX' : ''}${car.offTrack ? '  OFF TRACK' : ''}${car.wallContact ? '  WALL' : ''}\n` +
          `FL ${surfaceName(car, 0)}  FR ${surfaceName(car, 1)}\n` +
          `RL ${surfaceName(car, 2)}  RR ${surfaceName(car, 3)}\n` +
          `mask ${mask.file}  walls ${mask.walls.length}${hasArt ? '' : '  (blockout: no background art)'}   T = tuning`
        : undefined;
      renderer.draw(prev, curr, alpha, look, {
        underCars: (c) => {
          if (editor) drawMask(c, mask.canvas, editor.maskOpacity);
          else if (debug) drawMask(c, mask.canvas, 0.5);
        },
        overCars: (c) => {
          if (overhead) c.drawImage(overhead, 0, 0, renderer.trackWidth, renderer.trackHeight);
        },
        overlay: (c) => {
          if (debug || editor) {
            drawWalls(c, mask.walls, lw);
            if (!editor) drawTrackData(c, json, lw);
            drawWheels(c, prev, curr, alpha, physics, json.pxPerMeter, lw);
          }
          editor?.draw(c, lw);
        },
        text,
      });
      tuning?.update(curr, surfaces, physics);
    },
  });
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = String(err);
});

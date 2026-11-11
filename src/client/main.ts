import { buildStats, createWorld, resetCar, setCarBuild, step, TICK_HZ, type InputSource, type SimContext, type WorldState } from '../sim';
import { drawMask, drawTrackData, drawWalls, drawWheels } from './debug-draw';
import { DonutInput } from './input/dummy';
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
import audioConfig from '../../config/audio.json';
import vfxConfig from '../../config/vfx.json';
import { GameAudio } from './audio/audio';
import { soundTargets, topSpeedKph } from './audio/targets';
import { Vfx } from './vfx/vfx';
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
  // Dev: ?cars=N adds N-1 donut-driving test cars (VFX/sound load testing until AI lands).
  const extra = import.meta.env.DEV ? Math.min(19, Math.max(0, Number(new URLSearchParams(location.search).get('cars') ?? 1) - 1)) : 0;
  for (let i = 1; i <= extra; i++) drivers.push(new DonutInput(i));
  const vfx = new Vfx(mask.track.mask.width, mask.track.mask.height, vfxConfig);
  const audio = new GameAudio(audioConfig);

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
    } else if (a.type === 'mute') {
      console.info(`[audio] ${audio.toggleMute() ? 'muted' : 'unmuted'}`);
    } else if (a.type === 'cycleVfx') {
      console.info(`[vfx] quality: ${vfx.cycleQuality()}`);
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
        vfx: vfxConfig,
        vfxQuality: { get: () => vfx.quality, set: (q) => vfx.setQuality(q), clear: () => vfx.clear() },
        audio: audioConfig,
        volumes: { values: audio.volumes, set: (bus, v) => audio.setVolume(bus, v) },
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
        vfx,
        audio,
        /** Run n full frames (sim tick + VFX + draw) synchronously; returns ms per frame. */
        benchFrame: (n = 300) => {
          const t0 = performance.now();
          for (let k = 0; k < n; k++) {
            const inputs = drivers.map((d) => d.read(curr.tick));
            prev = curr;
            curr = step(curr, inputs, ctx);
            vfx.onTick(prev, curr, ctx.track, physics);
            vfx.update(1 / 60);
            drawFrame(1, 1 / 60);
          }
          return { msPerFrame: (performance.now() - t0) / n, particles: vfx.particles, dropped: vfx.dropped, cars: curr.cars.length };
        },
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
      vfx.onTick(prev, curr, ctx.track, physics);
      const me = curr.cars[0], was = prev.cars[0];
      if (me && was) audio.update(soundTargets(was, me, audioConfig, vfxConfig, physics, rules, surfaces, topSpeedKph(physics, buildStats(me.build, ctx.catalog).topSpeed)));
      for (const e of curr.events) {
        if (e.type === 'outOfBounds')
          console.warn(`[mask bug] car ${e.car} reached out-of-bounds at (${e.x.toFixed(1)}, ${e.y.toFixed(1)}) px in ${mask.file}; reset to spawn`);
      }
    },
    render(alpha, frameSeconds) {
      if (frameSeconds > 0) fps += (1 / frameSeconds - fps) * 0.05;
      vfx.update(frameSeconds);
      drawFrame(alpha, frameSeconds);
    },
  });

  function drawFrame(alpha: number, _frameSeconds: number): void {
    {
      const lw = renderer.trackPxPerCssPx();
      const car = curr.cars[0];
      const text = debug && car
        ? `${json.name}${json.fixture ? ' (test fixture)' : ''}  tick ${curr.tick} @ ${TICK_HZ} Hz   fps ${fps.toFixed(0)}\n` +
          `kph ${(car.speed * 3.6).toFixed(0)}${car.inPitLane ? '  PIT LIMITER' : ''}${car.inPitBox ? '  PIT BOX' : ''}${car.offTrack ? '  OFF TRACK' : ''}${car.wallContact ? '  WALL' : ''}\n` +
          `FL ${surfaceName(car, 0)}  FR ${surfaceName(car, 1)}\n` +
          `RL ${surfaceName(car, 2)}  RR ${surfaceName(car, 3)}\n` +
          `mask ${mask.file}  walls ${mask.walls.length}${hasArt ? '' : '  (blockout: no background art)'}
` +
          `vfx ${vfx.quality} (V)  particles ${vfx.particles}  cars ${curr.cars.length}  sound ${audio.volumes.muted ? 'muted' : audio.running ? 'on' : 'waiting for a key'} (M)   T = tuning`
        : undefined;
      renderer.draw(prev, curr, alpha, look, {
        underCars: (c) => {
          vfx.drawUnder(c, renderer.trackWidth, renderer.trackHeight);
          if (editor) drawMask(c, mask.canvas, editor.maskOpacity);
          else if (debug) drawMask(c, mask.canvas, 0.5);
        },
        overCars: (c) => {
          vfx.drawOver(c, json.pxPerMeter);
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
    }
  }
  document.getElementById('loading')?.remove();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = String(err);
});

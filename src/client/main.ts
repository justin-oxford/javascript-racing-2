import { aiInputSource, buildRacingLine, buildStats, createWorld, resetCar, setCarBuild, step, timingSequence, TICK_DT, TICK_HZ, type AiConfig, type CarBuild, type InputSource, type RacingLine, type SimContext, type WorldState } from '../sim';
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
  siteUrl,
  surfaces,
  surfacesConfig,
  type MaskState,
} from './track-loader';
import aiJson from '../../config/ai.json';
import audioConfig from '../../config/audio.json';
import hudConfig from '../../config/hud.json';
import { Hud } from './hud/hud';
import { browserStore, Session } from './hud/session';
import { TimingLines } from './hud/timing-lines';
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
  let drivers: InputSource[] = [keyboard];
  // Dev: ?cars=N adds N-1 donut-driving test cars (VFX/sound load testing).
  const extra = import.meta.env.DEV ? Math.min(19, Math.max(0, Number(new URLSearchParams(location.search).get('cars') ?? 1) - 1)) : 0;
  for (let i = 1; i <= extra; i++) drivers.push(new DonutInput(i));

  // AI opponents (card 05): count + difficulty from the HUD menu, remembered in this browser;
  // ?ai=N&level=hard overrides. The AI reads config/ai.json live, so tuning-panel changes apply at once.
  const aiCfg = aiJson as unknown as AiConfig;
  let racingLine: RacingLine | undefined = buildRacingLine(mask.track);
  const params = new URLSearchParams(location.search);
  const remembered = (() => { try { return JSON.parse(localStorage.getItem('jr2.ai') ?? '{}') as { count?: number; preset?: string }; } catch { return {}; } })();
  let aiCount = Math.min(9, Math.max(0, Number(params.get('ai') ?? remembered.count ?? 0) || 0));
  let aiPreset = params.get('level') ?? remembered.preset ?? aiCfg.defaultPreset;
  if (!aiCfg.presets[aiPreset]) aiPreset = aiCfg.defaultPreset;
  const vfx = new Vfx(mask.track.mask.width, mask.track.mask.height, vfxConfig);
  const audio = new GameAudio(audioConfig);
  const timingLines = new TimingLines(hudConfig);
  // Static layer = background + timing lines + every mark so far. Rebuilt only when something moves.
  renderer.staticPainter = (c) => {
    timingLines.drawStatic(c, ctx.track);
    vfx.drawHistory(c);
  };
  renderer.overhead = overhead;
  vfx.paintLive = (fn) => renderer.paintStatic(fn);
  vfx.onInvalidate = () => renderer.invalidateStatic();
  let lineSig = timingLines.signature(ctx.track);
  const startBuild = curr0Build();
  const session = new Session(browserStore(), json.id, startBuild.spec, startBuild.team);
  function curr0Build(): CarBuild {
    return physics.defaultCar;
  }
  /** Swap the player's car build and put it back in the pits (spec/team change). */
  const rebuildCar = (build: CarBuild): void => {
    curr = resetCar(setCarBuild(curr, 0, build), 0, json.spawn, ctx);
    prev = curr;
  };
  const stoppedInBox = (): boolean => {
    const c = curr.cars[0];
    return !!c && c.inPitBox && Math.abs(c.speed) * 3.6 < physics.fuel.pitServiceMaxKph;
  };
  /** (Re)start practice: the player plus aiCount AI cars, everyone back on the grid. */
  const startPractice = (): void => {
    const me = curr?.cars[0]?.build ?? startBuild;
    if (!racingLine) aiCount = 0;
    const teams = ctx.catalog.teams.filter((t) => t.id !== me.team);
    const builds: CarBuild[] = [me, ...Array.from({ length: aiCount }, (_, k) => ({ ...physics.defaultCar, spec: me.spec, team: teams[k % teams.length]!.id }))];
    if (aiCount === 0) for (let i = 1; i <= extra; i++) builds.push(physics.defaultCar);
    curr = createWorld(ctx, builds);
    prev = curr;
    drivers = aiCount === 0
      ? [keyboard, ...Array.from({ length: extra }, (_, k) => new DonutInput(k + 1))]
      : [keyboard, ...Array.from({ length: aiCount }, (_, k) =>
          aiInputSource(k + 1, () => ({ world: curr, ctx, line: racingLine }), () => aiCfg.presets[aiPreset] ?? aiCfg.presets[aiCfg.defaultPreset]!, () => aiCfg, 1000 + k))];
    hud.setAi(aiCount, aiPreset);
  };

  const hud = new Hud(canvas, hudConfig, ctx.catalog, {
    onSpec: (spec) => {
      const b = curr.cars[0]!.build;
      if (b.spec === spec) return;
      rebuildCar({ ...b, spec });
      session.changeSpec(spec); // spec change resets times
    },
    onTeam: (team) => {
      const b = curr.cars[0]!.build;
      if (b.team === team) return;
      rebuildCar({ ...b, team });
      session.changeTeam(team); // team change keeps times so teams can be compared
    },
    onSetup: (slot, value) => {
      if (!stoppedInBox()) return; // setup changes only while stopped in a pit box
      const b = curr.cars[0]!.build;
      const build = { ...b, setup: { ...b.setup, [slot]: value } };
      curr = setCarBuild(curr, 0, build);
      prev = setCarBuild(prev, 0, build);
    },
    onAi: (count, preset) => {
      aiCount = count;
      aiPreset = preset;
      try { localStorage.setItem('jr2.ai', JSON.stringify({ count, preset })); } catch { /* private window: not remembered */ }
      startPractice();
    },
  }, () => renderer.trackHeight, siteUrl, Object.keys(aiCfg.presets));

  let prev: WorldState = createWorld(ctx, drivers.length);
  let curr: WorldState = prev;
  startPractice();
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
    else if (a.type === 'gridSlot') {
      // Practice: 1-9, 0 = slot 10.
      const slot = json.grid[a.slot === 0 ? 9 : a.slot - 1];
      if (slot) {
        curr = resetCar(curr, 0, slot, ctx);
        prev = curr;
      }
    }
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
        ai: aiCfg,
        volumes: { values: audio.volumes, set: (bus, v) => audio.setVolume(bus, v) },
        onBuildChange: (build) => {
          const was = curr.cars[0]!.build;
          curr = setCarBuild(curr, 0, build);
          prev = setCarBuild(prev, 0, build);
          if (build.spec !== was.spec) session.changeSpec(build.spec);
          else if (build.team !== was.team) session.changeTeam(build.team);
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
        session,
        /** Dev: who drives each car (AI drivers expose .state). */
        drivers: () => drivers,
        /** Dev: replace who drives car i (e.g. a scripted test driver). */
        setDriver: (i: number, d: InputSource) => (drivers[i] = d),
        grid: (n: number) => {
          const slot = json.grid[n];
          if (slot) { curr = resetCar(curr, 0, slot, ctx); prev = curr; }
        },
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
          racingLine = buildRacingLine(mask.track);
          if (!hasArt) renderer.background = mask.blockout;
          renderer.invalidateStatic();
          console.info(`[track] hot-reloaded ${id}/${mask.file}`);
        } else if (file === f.background) {
          const bg = await loadBackground(json);
          hasArt = !!bg;
          renderer.background = bg ?? mask.blockout;
        } else if (file === f.overhead) {
          overhead = await loadOverhead(json);
          renderer.overhead = overhead;
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

  // Dev: run n real game ticks synchronously (timing, session, VFX, audio), then draw once.
  // Lets tests drive laps even when the browser tab isn't rendering.
  if (import.meta.env.DEV) Object.assign(window, {
    __advance: (n: number) => {
      for (let k = 0; k < n; k++) loopHooks.tick();
      loopHooks.render(1, 1 / 60);
      return curr.tick;
    },
  });

  const loopHooks = {
    tick() {
      const inputs = drivers.map((d) => d.read(curr.tick));
      prev = curr;
      curr = step(curr, inputs, ctx);
      vfx.onTick(prev, curr, ctx.track, physics);
      const me = curr.cars[0], was = prev.cars[0];
      if (me && was) audio.update(soundTargets(was, me, audioConfig, vfxConfig, physics, rules, surfaces, topSpeedKph(physics, buildStats(me.build, ctx.catalog).topSpeed)));
      for (const e of curr.events) {
        if (e.type === 'sector' || e.type === 'lap') {
          session.onEvent(e, e.car === 0);
          if (e.car === 0) {
            const tile = e.type === 'lap' ? session.tiles[3]! : session.tiles[e.sector]!;
            const key = e.type === 'lap' ? 'startFinish' : timingSequence(json)[e.sector];
            if (key) timingLines.flashLine(key, tile.color, performance.now());
          }
        }
        if (e.type === 'outOfBounds')
          console.warn(`[mask bug] car ${e.car} reached out-of-bounds at (${e.x.toFixed(1)}, ${e.y.toFixed(1)}) px in ${mask.file}; reset to spawn`);
      }
    },
    render(alpha: number, frameSeconds: number) {
      if (frameSeconds > 0) fps += (1 / frameSeconds - fps) * 0.05;
      vfx.update(frameSeconds);
      drawFrame(alpha, frameSeconds);
    },
  };
  startLoop(loopHooks);

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
          // Background, lines and marks come from the renderer's static layer; only a flash is per-frame.
          const sig = timingLines.signature(ctx.track);
          if (sig !== lineSig) {
            lineSig = sig;
            renderer.invalidateStatic(); // editor moved a line
          }
          timingLines.drawFlash(c, ctx.track, performance.now());
          if (editor) drawMask(c, mask.canvas, editor.maskOpacity);
          else if (debug) drawMask(c, mask.canvas, 0.5);
        },
        overCars: (c) => {
          vfx.drawOver(c, json.pxPerMeter); // the renderer draws the pre-scaled overhead after this
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
        textTop: hud.barHeightBackingPx(),
      });
      tuning?.update(curr, surfaces, physics);
      const me = curr.cars[0];
      if (me) {
        hud.fuelTankKg = physics.fuel.tankKg;
        hud.update(me, (curr.tick + alpha) * TICK_DT, session, !!json.timingLines.startFinish, stoppedInBox());
      }
    }
  }
  document.getElementById('loading')?.remove();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = String(err);
});

import { aiInputSource, bodyOffsetM, buildRacingLine, buildStats, optimizeRacingLine, speedProfile, type LineOptimizerConfig, createRaceWorld, createWorld, resetCar, setCarBuild, step, timingSequence, TICK_DT, TICK_HZ, type AiConfig, type CarBuild, type InputSource, type RacingLine, type SimContext, type WorldState } from '../sim';
import { drawMask, drawTrackData, drawWalls, drawWheels } from './debug-draw';
import { DonutInput } from './input/dummy';
import { KeyboardInput } from './input/keyboard';
import { startLoop } from './loop';
import { Renderer, type CarLook } from './render';
import {
  chooseTrackId,
  contact,
  raceConfig,
  slipstream,
  getTrackJsonStub,
  loadBackground,
  loadMask,
  loadOverhead,
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
import { RaceHud } from './hud/race-hud';
import { Liveries } from './livery';
import liveryConfig from '../../config/livery.json';
import racingLineConfig from '../../config/racing-line.json';
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
  const [background, overhead0, liveries] = await Promise.all([loadBackground(json), loadOverhead(json), new Liveries(liveryConfig).load(siteUrl)]);
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
  /** Swap the player's car build and put it back in the pits (spec/team change). A race restarts. */
  const rebuildCar = (build: CarBuild): void => {
    if (raceSetup) {
      curr = setCarBuild(curr, 0, build);
      return startRace(raceSetup.laps, raceSetup.grid);
    }
    curr = resetCar(setCarBuild(curr, 0, build), 0, json.spawn, ctx);
    prev = curr;
  };
  /** Stopped in a box that services the player (any box in practice, its own in a race). */
  const stoppedInBox = (): boolean => !!curr.cars[0]?.servicing;
  const aiDrivers = (count: number): InputSource[] => Array.from({ length: count }, (_, k) =>
    aiInputSource(k + 1, () => ({ world: curr, ctx, line: racingLine }), () => aiCfg.presets[aiPreset] ?? aiCfg.presets[aiCfg.defaultPreset]!, () => aiCfg, 1000 + k));
  const aiBuilds = (me: CarBuild, count: number): CarBuild[] => {
    const teams = ctx.catalog.teams.filter((t) => t.id !== me.team);
    return Array.from({ length: count }, (_, k) => ({ ...physics.defaultCar, spec: me.spec, team: teams[k % teams.length]!.id }));
  };
  /** The race being run (for Restart), undefined in practice. */
  let raceSetup: { laps: number; grid: 'random' | 'pole' | 'back' } | undefined;
  /** (Re)start practice: the player plus aiCount AI cars, everyone back on the grid. */
  const startPractice = (): void => {
    raceSetup = undefined;
    const me = curr?.cars[0]?.build ?? startBuild;
    if (!racingLine) aiCount = 0;
    const builds: CarBuild[] = [me, ...aiBuilds(me, aiCount)];
    if (aiCount === 0) for (let i = 1; i <= extra; i++) builds.push(physics.defaultCar);
    curr = createWorld(ctx, builds);
    prev = curr;
    drivers = aiCount === 0 ? [keyboard, ...Array.from({ length: extra }, (_, k) => new DonutInput(k + 1))] : [keyboard, ...aiDrivers(aiCount)];
    hud.setAi(aiCount, aiPreset);
    raceHud?.hide();
  };
  /** (Re)start a race (card 06): grid, lights, own pit boxes, flag. Uses the menu's AI count (at least 1). */
  const startRace = (laps: number, grid: 'random' | 'pole' | 'back'): void => {
    if (!racingLine || !json.timingLines.startFinish) {
      console.warn('[race] this track needs a racing line and a start/finish line for races');
      return startPractice();
    }
    raceSetup = { laps, grid };
    const me = curr?.cars[0]?.build ?? startBuild;
    const count = Math.max(1, aiCount);
    const builds: CarBuild[] = [me, ...aiBuilds(me, count)];
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!; // client-side: the sim itself stays seeded
    curr = createRaceWorld(ctx, builds, { laps, seed, playerSlot: grid === 'pole' ? 0 : grid === 'back' ? count : undefined });
    prev = curr;
    drivers = [keyboard, ...aiDrivers(count)];
    hud.setAi(aiCount, aiPreset);
    if (curr.race!.sharedBoxes) console.warn(`[race] ${ctx.track.boxes.length} pit box(es) for ${builds.length} cars: boxes are shared round-robin`);
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
      if (raceSetup) startRace(raceSetup.laps, raceSetup.grid);
      else startPractice();
    },
    onRace: (laps, grid) => startRace(laps, grid),
    onPractice: () => startPractice(),
  }, () => renderer.trackHeight, siteUrl, Object.keys(aiCfg.presets));
  hud.setRaceDefaults(ctx.race.defaultLaps);
  const raceHud: RaceHud = new RaceHud(hud.element, ctx.catalog, siteUrl, {
    onRestart: () => raceSetup && startRace(raceSetup.laps, raceSetup.grid),
    onMenu: () => { startPractice(); hud.openMenu(); },
  });

  let prev: WorldState = createWorld(ctx, drivers.length);
  let curr: WorldState = prev;
  startPractice();
  let debug = false;
  let fps = TICK_HZ; // display smoothing starts at the expected rate, not 0

  keyboard.onAction((a) => {
    // In a race, R (reset to pits) and 0-9 (grid slots) are off: they'd teleport you round the lap.
    if (curr.race && (a.type === 'reset' || a.type === 'gridSlot')) return;
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
    ? new (await import('./editor/editor')).TrackEditor(renderer, json, (kerbUse) => {
        // Racing line optimizer: seed (kept) -> generated line + reference speed profile, then the AI follows it.
        const seed = json.racingLineSeed?.length ? json.racingLineSeed : [...json.racingLine];
        if (seed.length < 3) return 'Place a rough racing line first (Racing line +): it is the seed.';
        json.racingLineSeed = seed;
        const out = optimizeRacingLine(ctx.track, seed, { ...(racingLineConfig as LineOptimizerConfig), kerbUse }, physics);
        const ppm = json.pxPerMeter;
        json.racingLine = out.line;
        json.racingLineSpeed = Array.from(speedProfile(out.line.map((p) => p.x / ppm), out.line.map((p) => p.y / ppm), physics, buildStats(physics.defaultCar, ctx.catalog), { cornerMargin: 1, brakeMargin: 1, fuelKg: physics.fuel.startKg / 2 }), (v) => Math.round(v * 10) / 10);
        racingLine = buildRacingLine(ctx.track);
        return `Optimized: ${out.line.length} points, ${out.lengthM.toFixed(0)} m, tightest radius ${out.minRadiusM.toFixed(1)} m, kerb use ${Math.round(kerbUse * 100)}%.`;
      }, racingLineConfig.kerbUse)
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
        contact,
        race: raceConfig,
        slipstream,
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
        /** Dev: an AI drives your car (hands-off race tests). Undo with __game.setDriver(0, keyboard) or reload. */
        autopilot: () => (drivers[0] = aiInputSource(0, () => ({ world: curr, ctx, line: racingLine }), () => aiCfg.presets[aiPreset] ?? aiCfg.presets[aiCfg.defaultPreset]!, () => aiCfg, 999)),
        keyboard,
        liveries,
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
    get bodyOffsetM() { return bodyOffsetM(physics); },
    get widthM() { return physics.car.widthM; },
    drawCar: (c, car, index, lengthPx, devicePerTrackPx) => {
      const team = ctx.catalog.teams.find((t) => t.id === car.build.team);
      if (!team) return false;
      liveries.draw(c, car, { primary: team.colors.primary, helmet: index === 0 ? liveryConfig.playerHelmet : team.colors.helmet }, lengthPx, devicePerTrackPx, physics);
      return true;
    },
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
      if (me && was) {
        audio.update(soundTargets(was, me, audioConfig, vfxConfig, physics, rules, surfaces, topSpeedKph(physics, buildStats(me.build, ctx.catalog).topSpeed)));
        // Wind: grows with speed; tucked into a tow it drops and darkens (slipstream.json wind).
        const wd = slipstream.wind, sp = Math.min(1, (Math.abs(me.speed) * 3.6) / wd.fullKph), tuck = me.tow / Math.max(0.01, slipstream.tow.maxDragReduction);
        audio.setWind(wd.gain * sp * sp * (1 - wd.towDuck * tuck), wd.baseHz * (0.6 + 0.6 * sp) * (1 - wd.towHzDrop * tuck));
      }
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
          vfx.drawWakes(c, curr, physics, json.pxPerMeter, slipstream.wake);
          vfx.drawOver(c, json.pxPerMeter); // the renderer draws the pre-scaled overhead after this
        },
        overlay: (c) => {
          if (debug || editor) {
            drawWalls(c, mask.walls, lw);
            if (!editor) drawTrackData(c, json, lw);
            drawWheels(c, prev, curr, alpha, physics, json.pxPerMeter, lw);
          }
          // Race: outline your own pit box while you're in the pit lane.
          const me = curr.cars[0], myBox = curr.race?.cars[0]?.box ?? -1;
          if (me?.inPitLane && myBox >= 0) {
            const b = ctx.track.boxes[myBox]!;
            c.save();
            c.strokeStyle = `rgba(255, 221, 0, ${0.55 + 0.45 * Math.sin(performance.now() / 160)})`;
            c.lineWidth = 4 * lw;
            c.strokeRect(b.x0 - 3, b.y0 - 3, b.x1 - b.x0 + 6, b.y1 - b.y0 + 6);
            c.fillStyle = 'rgba(255, 221, 0, 0.18)';
            c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
            c.restore();
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
        const race = curr.race;
        hud.update(me, (curr.tick + alpha) * TICK_DT, session, !!json.timingLines.startFinish, stoppedInBox(), race ? { laps: race.laps, box: (race.cars[0]?.box ?? -1) + 1 } : undefined);
        raceHud.update(curr, race?.sharedBoxes ? `${ctx.track.boxes.length} pit boxes for ${curr.cars.length} cars: shared` : '');
      }
    }
  }
  document.getElementById('loading')?.remove();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = String(err);
});

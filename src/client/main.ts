import { aiStartCompound, computeExitLine, rainAt, shower, consumableScale, defaultPitPlan, offsetPath, racecraftOffsets, normalizeSetup, nextSession, newSurfaceGrid, seedRubber, type SurfaceGrid, aiInputSource, assignDrivers, driverPreset, type DriverDef, bodyOffsetM, buildRacingLine, buildStats, optimizeRacingLine, speedProfile, type LineOptimizerConfig, createQualiWorld, createRaceWorld, createWorld, pitBoxPose, pitQueuePoses, retireFromQuali, resetCar, setCarBuild, step, timingSequence, TICK_DT, TICK_HZ, type AiConfig, type CarBuild, type CarSetup, type DamageMode, type SessionSettings, type InputSource, type RacingLine, type SimContext, type WorldState } from '../sim';
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
  assists,
  damage,
  ers,
  evolution,
  getTrackJsonStub,
  loadBackground,
  loadMask,
  loadOverhead,
  loadNightArt,
  physics,
  rules,
  simContext,
  siteUrl,
  surfaces,
  surfacesConfig,
  type MaskState,
} from './track-loader';
import aiJson from '../../config/ai.json';
import driversJson from '../../config/drivers.json';
import audioConfig from '../../config/audio.json';
import hudConfig from '../../config/hud.json';
import { Hud, SETUP_LABELS } from './hud/hud';
import { pitBoardHtml } from './hud/pit-board';
import { BalanceTracker } from './hud/balance';
import { RaceHud } from './hud/race-hud';
import { drawCarLabels, LABEL_MODES, nextLabelMode, type LabelMode } from './hud/car-labels';
import { carIdentity, sessionOrder, setCarDrivers, setPlayerIdentity } from './hud/running-order';
import { MainMenu, type RecordRow } from './menu/main-menu';
import { DEFAULT_SETTINGS, nameCode, pbPrefix, ProfileStore, type Profile, type ProfileSettings } from './menu/profile';
import { Liveries } from './livery';
import liveryConfig from '../../config/livery.json';
import racingLineConfig from '../../config/racing-line.json';
import { browserStore, Session } from './hud/session';
import { TimingLines } from './hud/timing-lines';
import vfxConfig from '../../config/vfx.json';
import { GameAudio } from './audio/audio';
import { soundTargets, topSpeedKph } from './audio/targets';
import { Vfx } from './vfx/vfx';
import { EvolutionLayer } from './vfx/evolution-layer';
import { WeatherLayer } from './vfx/weather-layer';
import nightJson from '../../config/night.json';
import { drawRearLights, previewNight, shadeImage, type NightConfig } from './night';
import './style.css';

async function main(): Promise<void> {
  const trackId = chooseTrackId();
  const stub = getTrackJsonStub(trackId);
  let mask: MaskState = await loadMask(stub);
  const json = mask.track.json; // the stub, completed in place: the editor edits this same object
  const [background, overhead0, liveries, nightArt] = await Promise.all([loadBackground(json), loadOverhead(json), new Liveries(liveryConfig).load(siteUrl), loadNightArt(json)]);
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
  // Player profiles (Main menu + profiles card): name, helmet, team, settings and keys live in the active
  // profile in this browser. The first one is seeded from the settings remembered before profiles existed.
  const kv = browserStore();
  const legacy = (k: string): string | null => kv.getItem(k);
  const legacyAi = (() => { try { return JSON.parse(legacy('jr2.ai') ?? '{}') as { count?: number; preset?: string }; } catch { return {}; } })();
  const profiles = new ProfileStore(kv, () => Math.random().toString(36).slice(2, 10));
  let profile: Profile = profiles.active({
    helmet: liveryConfig.playerHelmet,
    settings: { ...DEFAULT_SETTINGS, ai: { count: legacyAi.count ?? 0, preset: legacyAi.preset ?? '' }, perf: legacy('jr2.perf') === 'equal' ? 'equal' : 'team', damage: (['visual', 'realistic'] as const).find((m) => m === legacy('jr2.damage')) ?? 'off', labels: LABEL_MODES.find((m) => m === legacy('jr2.labels')) ?? 'position' },
  });
  /** Change the active profile's settings (and remember them). */
  const persist = (f: (s: ProfileSettings) => ProfileSettings): void => { profile = profiles.save({ ...profile, settings: f(profile.settings) }); };
  let aiCount = Math.min(9, Math.max(0, Number(params.get('ai') ?? profile.settings.ai.count) || 0));
  let aiPreset = params.get('level') ?? (profile.settings.ai.preset || aiCfg.defaultPreset);
  if (!aiCfg.presets[aiPreset]) aiPreset = aiCfg.defaultPreset;
  // Car performance (Equal performance card): team stats or equalised cars.
  let perfMode: 'team' | 'equal' = profile.settings.perf;
  /** A build with this session's performance mode on it (every car, the player's too). */
  const withPerf = (b: CarBuild): CarBuild => {
    const { equalise: _old, ...rest } = b;
    return perfMode === 'equal' ? { ...rest, equalise: ctx.race.equalise } : rest;
  };
  // Car damage setting (Car damage card), remembered in this browser. Off by default (Justin).
  let damageMode: DamageMode = profile.settings.damage;
  /** This session's weather seed (Wet weather card: a Changeable shower comes from it). */
  let weatherSeed = 1;
  const settings = (): SessionSettings => ({ damage: damageMode, raceLength: profile.settings.race.length, weather: profile.settings.weather, weatherSeed });
  /** Race strategy card: the player's starting compound and fuel (main menu), and a fresh pit board to match. */
  const withStrategy = (b: CarBuild): CarBuild => {
    const compound = profile.settings.race.compound;
    keyboard.pitPlan = defaultPitPlan(ctx.strategy, compound);
    return { ...b, compound, startFuelKg: physics.fuel.tankKg * profile.settings.race.fuel };
  };
  keyboard.fuelStepKg = ctx.strategy.pitBoard.fuelStepKg;
  keyboard.tankKg = physics.fuel.tankKg;
  /** When the pit board was last touched (it shows for a few seconds after a pit key). */
  let pitBoardAt = -Infinity;
  // AI drivers (AI driver roster card): the roster seeded once per page load, so the same drivers carry
  // through a whole race weekend. Car k + 1 is driven by roster[k].
  const driverSeed = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const roster = (driversJson as { drivers: DriverDef[] }).drivers;
  const lineup = assignDrivers(roster, 19, driverSeed);
  const vfx = new Vfx(mask.track.mask.width, mask.track.mask.height, vfxConfig);
  const weatherLayer = new WeatherLayer();
  const evoLayer = new EvolutionLayer(evolution.visual ?? { rubberRgb: '22, 22, 24', rubberMaxAlpha: 0.55, marbleRgb: '38, 30, 24', marbleDots: 14 });
  vfx.wearRubber = !evolution.enabled;
  const audio = new GameAudio(audioConfig);
  const timingLines = new TimingLines(hudConfig);
  // Static layer = background + timing lines + every mark so far. Rebuilt only when something moves.
  renderer.staticPainter = (c) => {
    timingLines.drawStatic(c, ctx.track);
    evoLayer.draw(c, curr?.surface, json.pxPerMeter); // rubber + marbles from the sim, under the skid marks
    vfx.drawHistory(c);
  };
  renderer.overhead = overhead;
  vfx.paintLive = (fn) => renderer.paintStatic(fn);
  vfx.onInvalidate = () => renderer.invalidateStatic();
  let lineSig = timingLines.signature(ctx.track);
  const startBuild = curr0Build();
  /** PBs are kept per track + spec + performance mode: Equal-mode laps don't compare with team-stats laps. */
  const pbSpec = (spec: string): string => (perfMode === 'equal' ? `${spec}-equal` : spec);
  /** This profile's PB store: its own key prefix (the first profile keeps the pre-profile keys). */
  const pbStore = (p: Profile) => {
    const pre = pbPrefix(p);
    return { getItem: (k: string) => kv.getItem(pre + k), setItem: (k: string, v: string) => kv.setItem(pre + k, v), keys: () => kv.keys().filter((k) => (pre ? k.startsWith(pre) : !k.startsWith('p.'))).map((k) => k.slice(pre.length)) };
  };
  let session = new Session(pbStore(profile), json.id, pbSpec(startBuild.spec), startBuild.team);
  /** The player's car from the profile: preferred team and spec on the default car. */
  /** This track's base setup (Car setup overhaul card): track.json baseSetup, else the default car's. */
  function trackBase(): CarSetup {
    return normalizeSetup(json.baseSetup ?? physics.defaultCar.setup, ctx.catalog.specs.setup);
  }
  function curr0Build(): CarBuild {
    const d = physics.defaultCar;
    const team = profile.team && ctx.catalog.teams.some((t) => t.id === profile.team) ? profile.team : d.team;
    const spec = profile.settings.spec && ctx.catalog.specs.specs[profile.settings.spec] ? profile.settings.spec : d.spec;
    // Setup: this track's preset from the profile (Garage), else the track's base setup.
    const setup = normalizeSetup(profile.setups[json.id] ?? trackBase(), ctx.catalog.specs.setup, trackBase());
    return { ...d, team, spec, setup };
  }
  /** Swap the player's car build and put it back in the pits (spec/team change). A race restarts. */
  const rebuildCar = (b: CarBuild): void => {
    const build = withPerf(b);
    if (raceSetup) {
      curr = setCarBuild(curr, 0, build);
      return startRace(raceSetup.laps, raceSetup.grid, raceSetup.order);
    }
    if (curr.quali) { // qualifying: new car, same place (no restart)
      curr = setCarBuild(curr, 0, build);
      prev = setCarBuild(prev, 0, build);
      return;
    }
    curr = resetCar(setCarBuild(curr, 0, build), 0, json.spawn, ctx);
    prev = curr;
  };
  /** Stopped in a box that services the player (any box in practice, its own in a race). */
  const stoppedInBox = (): boolean => !!curr.cars[0]?.servicing;
  const aiDrivers = (count: number): InputSource[] => Array.from({ length: count }, (_, k) =>
    aiInputSource(k + 1, () => ({ world: curr, ctx, line: racingLine }), () => driverPreset(aiCfg.presets[aiPreset] ?? aiCfg.presets[aiCfg.defaultPreset]!, lineup[k], aiCfg.skill?.spread ?? 0), () => aiCfg, 1000 + k));
  setCarDrivers([undefined, ...lineup]);
  const aiBuilds = (me: CarBuild, count: number): CarBuild[] => {
    const teams = ctx.catalog.teams.filter((t) => t.id !== me.team);
    // The AI runs this track's base setup (track.json baseSetup, from npm run setup-search).
    const aiSetup = trackBase();
    return Array.from({ length: count }, (_, k) => withPerf({ ...physics.defaultCar, setup: aiSetup, spec: me.spec, team: teams[k % teams.length]!.id }));
  };
  /** Player's fuel use per lap (HUD fuel margin): fuel and lap count at the last line crossing. */
  const fuelLap = { laps: -1, kg: 0, perLap: 0 };
  /** The race being run (for Restart), undefined in practice. */
  let raceSetup: { laps: number; grid: 'random' | 'pole' | 'back'; order?: number[] | undefined } | undefined;
  /** The race weekend in progress (practice -> qualifying -> race), undefined otherwise. */
  let weekend: { laps: number; stage: 'practice' | 'quali' | 'race'; grid?: number[]; started?: boolean } | undefined;
  /** (Re)start practice: the player plus aiCount AI cars, everyone back on the grid. */
  // Track evolution (POLISH card): a new weekend or standalone session starts from the profile's starting
  // state; the sessions of a weekend carry the surface over (marbles swept, a little rubber lost).
  /** After every sim tick (the loop and the dev bench alike): the balance readout and evolution redraws. */
  function afterTick(): void {
    // Setup balance readout: in practice, which axle lets go first in each corner (player only).
    if (balance && !curr.race && !curr.quali && curr.cars[0]) {
      balance.update(curr.cars[0]);
      if (curr.tick % 30 === 0) hud.setBalance(balance.corners.map((_, k) => ({ name: `T${k + 1}`, ...balance!.stats[k]!, passes: balance!.stats[k]!.front + balance!.stats[k]!.rear + balance!.stats[k]!.neither })));
    }
    // Track evolution visuals: refresh every ~15 s (the skid fade already rebuilds that often, but not
    // with effects off). A new session's surface shows at once (withSurface).
    if (curr.surface && curr.tick % (60 * 15) === 0) renderer.invalidateStatic();
  }
  /** Setup balance readout (practice). Rebuilt with the racing line; reset when the setup changes. */
  let balance: BalanceTracker | undefined = racingLine ? new BalanceTracker(racingLine) : undefined;
  const freshSurface = () => (ctx.evolution.enabled ? seedRubber(newSurfaceGrid(ctx.track, ctx.evolution), ctx.track, json.racingLine, profile.settings.trackStart, ctx.evolution) : undefined);
  const withSurface = (w: WorldState, s: SurfaceGrid | undefined): WorldState => {
    renderer.invalidateStatic(); // show the new session's track at once
    const { surface: _old, ...rest } = w;
    return s ? { ...rest, surface: s } : rest;
  };
  const startPractice = (keepWeekend = false): void => {
    raceSetup = undefined;
    if (!keepWeekend) weekend = undefined;
    const me = withStrategy(withPerf(curr?.cars[0]?.build ?? startBuild));
    weatherSeed = crypto.getRandomValues(new Uint32Array(1))[0]!; // a new shower each session
    if (!racingLine) aiCount = 0;
    const builds: CarBuild[] = [me, ...aiBuilds(me, aiCount)];
    if (aiCount === 0) for (let i = 1; i <= extra; i++) builds.push(physics.defaultCar);
    // Mid-weekend practice restarts (menu changes) keep the track as it is; anything else starts afresh.
    const keepTrack = keepWeekend && weekend?.stage === 'practice' && weekend.started && curr?.surface;
    const was = curr?.surface;
    curr = withSurface(createWorld(ctx, builds, settings()), keepTrack ? was : freshSurface());
    if (keepWeekend && weekend) weekend = { ...weekend, started: true };
    prev = curr;
    drivers = aiCount === 0 ? [keyboard, ...Array.from({ length: extra }, (_, k) => new DonutInput(k + 1))] : [keyboard, ...aiDrivers(aiCount)];
    hud.setAi(aiCount, aiPreset);
    raceHud?.hide();
  };
  /** (Re)start a race (card 06): grid, lights, own pit boxes, flag. Uses the menu's AI count (at least 1). */
  const startRace = (laps: number, grid: 'random' | 'pole' | 'back', order?: number[]): void => {
    if (!racingLine || !json.timingLines.startFinish) {
      console.warn('[race] this track needs a racing line and a start/finish line for races');
      return startPractice();
    }
    raceSetup = { laps, grid, order };
    const carried = curr?.surface;
    if (!order) weekend = undefined; // a quick race leaves any weekend
    const me = withStrategy(withPerf(curr?.cars[0]?.build ?? startBuild));
    const count = Math.max(1, aiCount);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!; // client-side: the sim itself stays seeded
    weatherSeed = seed;
    // The AI's starting tyres (Race strategy card): seeded, from the race length.
    const scale = consumableScale(profile.settings.race.length, laps, ctx.strategy);
    const builds: CarBuild[] = [me, ...aiBuilds(me, count).map((b, k) => ({ ...b, compound: aiStartCompound(laps, scale, ctx.strategy, (((seed ^ ((k + 1) * 2654435761)) >>> 0) % 1000) / 1000) }))];
    curr = createRaceWorld(ctx, builds, { laps, seed, playerSlot: grid === 'pole' ? 0 : grid === 'back' ? count : undefined, grid: order, settings: settings() });
    // The race of a weekend: the track as qualifying left it, swept. A quick race: the starting state.
    curr = withSurface(curr, order && carried ? nextSession(carried, ctx.evolution) : freshSurface());
    prev = curr;
    drivers = [keyboard, ...aiDrivers(count)];
    hud.setAi(aiCount, aiPreset);
    if (curr.race!.sharedBoxes) console.warn(`[race] ${ctx.track.boxes.length} pit box(es) for ${builds.length} cars: boxes are shared round-robin`);
  };

  /** Race weekend, step 1: practice with the menu's AI, a banner to move on to qualifying. */
  const startWeekend = (laps: number): void => {
    if (!racingLine || !json.timingLines.startFinish || !pitQueuePoses(racingLine, 1, json.pxPerMeter)) {
      console.warn('[weekend] this track needs a racing line, a start/finish line and a pit lane for a race weekend');
      return startPractice();
    }
    weekend = { laps, stage: 'practice' };
    startPractice(true);
  };
  /** Step 2: qualifying. Everyone queued at the pit exit; best lap sets the grid. */
  const startQuali = (): void => {
    if (!weekend) return;
    const me = withPerf(curr?.cars[0]?.build ?? startBuild);
    const count = Math.max(1, aiCount);
    const builds: CarBuild[] = [me, ...aiBuilds(me, count)];
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const fromPractice = curr.surface;
    curr = createQualiWorld(ctx, builds, seed, pitQueuePoses(racingLine, builds.length, json.pxPerMeter)!, settings());
    curr = withSurface(curr, fromPractice ? nextSession(fromPractice, ctx.evolution) : freshSurface());
    prev = curr;
    raceSetup = undefined;
    drivers = [keyboard, ...aiDrivers(count)];
    weekend = { ...weekend, stage: 'quali' };
  };
  /** Qualifying: end your session; parked in your own pit box (box 0), the rest fast-forwarded. */
  const endSession = (): void => {
    if (!curr.quali || curr.quali.cars[0]!.done) return;
    const pose = pitBoxPose(racingLine, 0, json.pxPerMeter) ?? json.spawn;
    curr = retireFromQuali(curr, 0, pose, ctx);
    prev = curr;
  };
  /** Step 3: the race, on the grid qualifying set. */
  const startWeekendRace = (): void => {
    if (!weekend || !curr.quali) return;
    const grid = [...curr.quali.order];
    weekend = { ...weekend, stage: 'race', grid };
    startRace(weekend.laps, 'random', grid);
  };

  const hud = new Hud(canvas, hudConfig, ctx.catalog, {
    onSpec: (spec) => {
      const b = curr.cars[0]!.build;
      if (b.spec === spec) return;
      rebuildCar({ ...b, spec });
      session.changeSpec(pbSpec(spec)); // spec change resets times
      persist((s) => ({ ...s, spec }));
    },
    onTeam: (team) => {
      const b = curr.cars[0]!.build;
      if (b.team === team) return;
      rebuildCar({ ...b, team });
      session.changeTeam(team); // team change keeps times so teams can be compared
      profile = profiles.save({ ...profile, team });
    },
    onSetup: (slot, value) => {
      if (!stoppedInBox()) return; // setup changes only while stopped in a pit box
      const b = curr.cars[0]!.build;
      const build = { ...b, setup: normalizeSetup({ ...normalizeSetup(b.setup, ctx.catalog.specs.setup), [slot]: value }, ctx.catalog.specs.setup) };
      profile = profiles.save({ ...profile, setups: { ...profile.setups, [json.id]: { ...build.setup } } }); // this track's preset
      balance?.reset(); // a new setup: a fresh readout
      curr = setCarBuild(curr, 0, build);
      prev = setCarBuild(prev, 0, build);
    },
    onAi: (count, preset) => {
      aiCount = count;
      aiPreset = preset;
      persist((s) => ({ ...s, ai: { count, preset } }));
      if (raceSetup && !raceSetup.order) startRace(raceSetup.laps, raceSetup.grid);
      else if (!curr.quali && !raceSetup) startPractice(weekend?.stage === 'practice'); // mid-weekend: applies to the next session
    },
    onRace: (laps, grid) => startRace(laps, grid),
    onDamage: (mode) => {
      damageMode = mode;
      persist((s) => ({ ...s, damage: mode }));
      hud.setDamage(mode);
      if (raceSetup && !raceSetup.order) startRace(raceSetup.laps, raceSetup.grid);
      else if (!curr.quali && !raceSetup) startPractice(weekend?.stage === 'practice');
    },
    onPerf: (mode) => {
      perfMode = mode;
      session.changeSpec(pbSpec(curr.cars[0]!.build.spec)); // a different set of PBs
      persist((s) => ({ ...s, perf: mode }));
      hud.setPerf(mode);
      if (raceSetup && !raceSetup.order) startRace(raceSetup.laps, raceSetup.grid);
      else if (!curr.quali && !raceSetup) startPractice(weekend?.stage === 'practice');
    },
    onPractice: () => startPractice(),
    onPits: () => {
      if (curr.race || curr.quali) return;
      curr = resetCar(curr, 0, json.spawn, ctx);
      prev = curr;
    },
    onWeekend: (laps) => startWeekend(laps),
    onLabels: (m) => setLabels(m),
  }, () => renderer.trackHeight, siteUrl, Object.keys(aiCfg.presets));
  hud.setRaceDefaults(ctx.race.defaultLaps);
  const raceHud: RaceHud = new RaceHud(hud.element, ctx.catalog, {
    onRestart: () => raceSetup && startRace(raceSetup.laps, raceSetup.grid, raceSetup.order),
    onMenu: () => { startPractice(); hud.openMenu(); },
    onQualify: () => startQuali(),
    onEndSession: () => endSession(),
    onStartRace: () => startWeekendRace(),
  }, () => ({ height: renderer.trackHeight, pxPerMeter: json.pxPerMeter }), () => ctx.race);

  // Car labels: from the profile; position by default.
  let labelMode: LabelMode = profile.settings.labels;
  function setLabels(m: LabelMode): void {
    labelMode = m;
    hud.setLabels(m);
    if (profile.settings.labels !== m) persist((s) => ({ ...s, labels: m }));
  }
  hud.setLabels(labelMode);
  hud.setPerf(perfMode);
  hud.setDamage(damageMode);

  // ---- Night (Night races card): the track's night art, or ?night=preview faking it from the day art ----
  const nightCfg = nightJson as NightConfig;
  const preview = params.get('night') === 'preview';
  const night = nightArt.background
    ? { background: nightArt.background as CanvasImageSource, lightmap: nightArt.lightmap as CanvasImageSource | undefined }
    : preview ? previewNight(background ?? mask.blockout, mask.track.mask.width, mask.track.mask.height, json.racingLine, json.pxPerMeter, nightCfg) : undefined;
  let nightOn = false;
  const setNight = (on: boolean): void => {
    nightOn = on && !!night;
    renderer.background = nightOn ? night!.background : (background ?? mask.blockout);
    renderer.nightShade = nightOn ? shadeImage(mask.track.mask.width, mask.track.mask.height, nightCfg, night!.lightmap) : undefined;
    renderer.shadeRegionPx = nightCfg.regionM * json.pxPerMeter;
  };

  // ---- Profile -> game (Main menu + profiles card) ----
  /** The pause menu is open: no sim ticks. (The main menu leaves the world running behind it.) */
  let paused = false;
  /** Make the game match a profile: identity, keys, sound, effects, labels and session choices. */
  const applyProfile = (p: Profile): void => {
    const switched = p.id !== profile.id;
    const carChanged = p.team !== profile.team || p.settings.spec !== profile.settings.spec || JSON.stringify(p.setups[json.id]) !== JSON.stringify(profile.setups[json.id]);
    profile = p;
    setPlayerIdentity(nameCode(p.name), p.name);
    keyboard.setBindings(p.keybinds);
    for (const [bus, v] of Object.entries(p.settings.volumes)) if (bus in audio.volumes) audio.setVolume(bus as Parameters<typeof audio.setVolume>[0], v);
    if (vfx.quality !== p.settings.vfx) vfx.setQuality(p.settings.vfx);
    if (labelMode !== p.settings.labels) setLabels(p.settings.labels);
    if (p.settings.night !== nightOn && night) setNight(p.settings.night);
    aiCount = p.settings.ai.count;
    aiPreset = aiCfg.presets[p.settings.ai.preset] ? p.settings.ai.preset : aiCfg.defaultPreset;
    perfMode = p.settings.perf;
    damageMode = p.settings.damage;
    hud.setAi(aiCount, aiPreset);
    hud.setPerf(perfMode);
    hud.setDamage(damageMode);
    const b = curr0Build();
    if (switched) session = new Session(pbStore(p), json.id, pbSpec(b.spec), b.team);
    // A different car (team/spec) shows at once outside a session; a session keeps its cars until restarted.
    if ((switched || carChanged) && !curr.race && !curr.quali) {
      session.changeSpec(pbSpec(b.spec));
      session.changeTeam(b.team);
      rebuildCar(b);
    }
  };
  /** Local PBs on this track for the active profile (Records tab). */
  const records = (): RecordRow[] => {
    const store = pbStore(profile), prefix = `jsr.pb.${json.id}.`;
    const out: RecordRow[] = [];
    for (const k of store.keys()) {
      if (!k.startsWith(prefix)) continue;
      const [spec = '', team = ''] = k.slice(prefix.length).split('.');
      try {
        const lap = (JSON.parse(store.getItem(k) ?? 'null') as { lap?: number } | null)?.lap;
        if (lap) out.push({ spec: spec.replace(/-equal$/, ''), equal: spec.endsWith('-equal'), team, lap });
      } catch { /* skip a bad entry */ }
    }
    return out;
  };
  const menu = new MainMenu({
    catalog: ctx.catalog,
    aiPresets: Object.keys(aiCfg.presets),
    defaultPreset: aiCfg.defaultPreset,
    nightAvailable: !!night,
    evolution: ctx.evolution.enabled,
    trackName: json.name,
    trackId: json.id,
    setupFields: ctx.catalog.specs.setup.fields,
    trackBase: () => ({ ...trackBase() }),
    setupSlots: SETUP_LABELS,
    profiles,
    volumes: () => (['master', 'engine', 'tyres', 'impacts', 'ui'] as const).filter((b) => b in audio.volumes).map((bus) => ({ bus, value: audio.volumes[bus] })),
    records,
    onProfile: (p) => applyProfile(p),
    onStart: (kind) => {
      const s = profile.settings;
      if (kind === 'practice') startPractice();
      else if (kind === 'race') startRace(s.race.laps, s.race.grid);
      else startWeekend(s.race.laps);
    },
    onResume: () => {},
    onRestart: () => {
      if (curr.quali) startQuali();
      else if (raceSetup) startRace(raceSetup.laps, raceSetup.grid, raceSetup.order);
      else startPractice(weekend?.stage === 'practice');
    },
    onQuit: () => startPractice(),
    onOpenChange: (open, mode) => {
      keyboard.suspended = open;
      keyboard.release();
      paused = open && mode === 'pause'; // the main menu leaves the world running behind it
    },
  });

  let prev: WorldState = createWorld(ctx, [startBuild]); // the profile's car, on this track's base setup unless the profile has its own
  let curr: WorldState = prev;
  startPractice();
  if (preview && night && !profile.settings.night) persist((s) => ({ ...s, night: true })); // ?night=preview: start at night
  applyProfile(profile);
  // The front door: the main menu on load, unless a dev URL param skips straight in.
  if (!['track', 'ai', 'edit', 'garage', 'level', 'cars'].some((k) => params.has(k))) menu.open('main');
  let debug = false;
  let fps = TICK_HZ; // display smoothing starts at the expected rate, not 0

  keyboard.onAction((a) => {
    // In a race, 0-9 (grid slots) are off: they'd teleport you round the lap. (R is reset to track now:
    // held, in the sim; back to the pits is a menu button.)
    if ((curr.race || curr.quali) && a.type === 'gridSlot') return;
    if (a.type === 'pitBoard') pitBoardAt = performance.now();
    else if (a.type === 'pause') {
      if (!menu.isOpen) menu.open('pause');
    } else if (a.type === 'toggleDebug') {
      debug = !debug;
    } else if (a.type === 'mute') {
      console.info(`[audio] ${audio.toggleMute() ? 'muted' : 'unmuted'}`);
    } else if (a.type === 'cycleLabels') {
      setLabels(nextLabelMode(labelMode));
    } else if (a.type === 'cycleVfx') {
      const q = vfx.cycleQuality();
      persist((s) => ({ ...s, vfx: q }));
      console.info(`[vfx] quality: ${q}`);
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
        // ...and the EXIT line on top of it (racecraft), so the two stay in step.
        const rc = aiCfg.racecraft, lc = racingLineConfig as unknown as { exitLeadM: number; exitBumps: number };
        if (racingLine && rc) {
          json.racingLineExit = computeExitLine(racingLine, physics, buildStats(physics.defaultCar, ctx.catalog), { exitStraightM: rc.exitStraightM, exitShiftM: rc.exitShiftM, edgeM: rc.edgeM, exitLeadM: lc.exitLeadM, exitBumps: lc.exitBumps }, ppm).points;
          racingLine = buildRacingLine(ctx.track); // a fresh line object: the AI rebuilds its racecraft lines
        }
        return `Optimized: ${out.line.length} points, ${out.lengthM.toFixed(0)} m, tightest radius ${out.minRadiusM.toFixed(1)} m, kerb use ${Math.round(kerbUse * 100)}%.`;
      }, racingLineConfig.kerbUse)
    : undefined;
  if (editor) editor.craftLines = () => {
    if (!racingLine || !aiCfg.racecraft) return [];
    const o = racecraftOffsets(racingLine, aiCfg.racecraft, ctx), ppm = json.pxPerMeter;
    const px = (off: Float64Array) => { const p = offsetPath(racingLine!, off); return Array.from({ length: racingLine!.n }, (_, i) => ({ x: p.x[i]! * ppm, y: p.y[i]! * ppm })); };
    return [{ name: 'inside', color: 'rgba(255, 120, 60, 0.9)', points: px(o.inside) }, ...(o.exit.some((v) => v !== 0) ? [{ name: 'exit', color: 'rgba(80, 160, 255, 0.9)', points: px(o.exit) }] : [])];
  };
  // Tuning panel: always in dev; on the live site with ?tune=1 (no Save there: Copy all settings instead).
  const tuning = import.meta.env.DEV || new URLSearchParams(location.search).has('tune')
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
        assists,
        damage,
        ers,
        evolution,
        strategy: ctx.strategy,
        weather: ctx.weather,
        volumes: { values: audio.volumes, set: (bus, v) => audio.setVolume(bus, v) },
        onBuildChange: (b) => {
          const build = withPerf(b);
          const was = curr.cars[0]!.build;
          curr = setCarBuild(curr, 0, build);
          prev = setCarBuild(prev, 0, build);
          if (build.spec !== was.spec) session.changeSpec(pbSpec(build.spec));
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
            if (paused) { drawFrame(1, 1 / 60); continue; } // a real frame: paused = no sim
            const inputs = drivers.map((d) => d.read(curr.tick));
            prev = curr;
            curr = step(curr, inputs, ctx);
            afterTick();
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
      liveries.draw(c, car, { primary: team.colors.primary, helmet: index === 0 ? profile.helmet : team.colors.helmet }, lengthPx, devicePerTrackPx, physics);
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
      if (paused) return; // pause menu: the world stands still (rendering carries on)
      const q = curr.quali;
      const n = q && q.phase !== 'results' && q.cars[0]?.done ? Math.max(1, Math.round(ctx.race.qualiFastForward)) : 1;
      for (let k = 0; k < n; k++) loopHooks.simTick();
    },
    simTick() {
      const inputs = drivers.map((d) => d.read(curr.tick));
      prev = curr;
      curr = step(curr, inputs, ctx);
      afterTick();
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
          weatherLayer.drawWater(c, curr.surface, json.pxPerMeter, performance.now()); // standing water: the dry line shows lighter
          if (editor) drawMask(c, mask.canvas, editor.maskOpacity);
          else if (debug) drawMask(c, mask.canvas, 0.5);
        },
        lights: (c) => { if (nightOn) drawRearLights(c, prev, curr, alpha, json.pxPerMeter, nightCfg); },
        overCars: (c) => {
          vfx.drawWakes(c, curr, physics, json.pxPerMeter, slipstream.wake);
          vfx.drawOver(c, json.pxPerMeter); // the renderer draws the pre-scaled overhead after this
          // Wet weather: rain lights while it's wet, rain streaks while it rains.
          const rainNow = rainAt(curr.tick * TICK_DT, curr.settings?.weather, curr.settings?.weatherSeed ?? 0, ctx.weather);
          if (rainNow > 0 || curr.surface?.water) weatherLayer.drawRainLights(c, curr, physics, json.pxPerMeter, performance.now());
          weatherLayer.drawRain(c, rainNow, mask.track.mask.width, mask.track.mask.height, performance.now());
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
          if (!editor) {
            const codes = curr.cars.map((car, i) => {
              const team = ctx.catalog.teams.find((t) => t.id === car.build.team);
              return { code: carIdentity(i, team?.name).code, swatch: team?.colors.primary ?? '#888' };
            });
            drawCarLabels(c, prev, curr, alpha, labelMode, sessionOrder(curr, ctx.catalog), codes, json.pxPerMeter, lw, physics.car.lengthM * json.pxPerMeter * 0.55 + 3 * lw);
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
        // Fuel per lap, measured on the player's own laps (a refuel in between doesn't count).
        if (me.timing.laps !== fuelLap.laps) {
          if (fuelLap.kg > me.fuelKg && me.timing.laps === fuelLap.laps + 1) fuelLap.perLap = fuelLap.kg - me.fuelKg;
          fuelLap.laps = me.timing.laps; fuelLap.kg = me.fuelKg;
        }
        const fuelMargin = race && fuelLap.perLap > 0 ? me.fuelKg / fuelLap.perLap - Math.max(0, race.laps - me.timing.laps) : undefined;
        // Weather tag: rain now, or (Changeable) when the shower comes, or that the track is drying.
        {
          const wx = curr.settings?.weather, sec = curr.tick * TICK_DT, rainNow = rainAt(sec, wx, curr.settings?.weatherSeed ?? 0, ctx.weather);
          let text = '';
          if (rainNow > 0.01) text = `RAIN ${Math.round(rainNow * 100)}%`;
          else if (wx === 'changeable') {
            const sh = shower(curr.settings?.weatherSeed ?? 0, ctx.weather), lapSec = me.timing.laps > 0 && session.personalBest.lap ? session.personalBest.lap : 30;
            text = sec < sh.start ? `RAIN IN ${Math.max(1, Math.ceil((sh.start - sec) / lapSec))} LAP${Math.ceil((sh.start - sec) / lapSec) > 1 ? 'S' : ''}` : curr.surface?.water ? 'DRYING' : '';
          } else if (wx === 'wet' || curr.surface?.water) text = 'WET';
          hud.setWeather(text, rainNow > 0.01);
        }
        hud.update(me, (curr.tick + alpha) * TICK_DT, session, !!json.timingLines.startFinish, stoppedInBox(), race ? { laps: race.laps, box: (race.cars[0]?.box ?? -1) + 1 } : undefined, { holdFrac: me.rejoin.holdTicks / Math.max(1, ctx.race.reset.holdSec * TICK_HZ), penaltySec: me.rejoin.penaltyTicks / TICK_HZ }, { batteryFrac: me.ers.batteryKJ / Math.max(1, ctx.ers.battery.capacityKJ), fuelMargin }, {
          letter: ctx.strategy.compounds[me.compound].letter,
          color: ctx.strategy.compounds[me.compound].color,
          // The pit board: up for 3 s after a pit key, and all the time in the pit lane.
          board: me.inPitLane || performance.now() - pitBoardAt < 3000 ? pitBoardHtml(me.pitPlan, ctx.strategy, profile.keybinds, me, damageMode === 'realistic') : undefined,
        });
        raceHud.weekend = weekend;
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

// Live tuning panel (dev only, T toggles). Sliders edit the live config objects the sim reads every
// tick, so changes apply to the running car immediately. Save writes them back to /config.
// Tuning is Justin's job; this file's job is to be a good instrument.
import GUI, { type Controller } from 'lil-gui';
import type { CarBuild, PhysicsConfig, Rules, SurfaceDef, WorldState } from '../../sim';
import type { VfxConfig } from '../vfx/triggers';
import type { VfxQuality } from '../vfx/vfx';
import type { AudioConfig } from '../audio/targets';
import type { Volumes } from '../audio/audio';
import { formatTrackJson } from '../editor/format';
import { catalog } from '../track-loader';

/** [min, max, step] per slider. Anything missing gets a range around its current value. */
const RANGES: Record<string, [number, number, number]> = {
  'car.dryMassKg': [400, 1500, 1],
  'car.lengthM': [3, 7, 0.05],
  'car.widthM': [1.2, 2.5, 0.05],
  'car.wheelbaseM': [2, 4.5, 0.05],
  'car.trackWidthM': [1, 2.2, 0.05],
  'car.weightFront': [0.3, 0.7, 0.005],
  'car.cgHeightM': [0, 0.8, 0.01],
  'car.inertiaScale': [0.3, 3, 0.05],
  'engine.powerKW': [100, 1500, 5],
  'engine.topSpeedKph': [100, 450, 1],
  'engine.maxDriveForceN': [1000, 40000, 100],
  'engine.reverseForceN': [500, 10000, 50],
  'engine.maxReverseKph': [5, 60, 1],
  'brakes.maxForceN': [5000, 80000, 100],
  'brakes.frontBias': [0.3, 0.8, 0.005],
  'aero.dragCoef': [0, 3, 0.01],
  'aero.downforceCoef': [0, 0.001, 0.00001],
  'tyres.baseGrip': [0.3, 3, 0.01],
  'tyres.lateralGrip': [0.3, 2, 0.01],
  'tyres.lateralStiffness': [0.05, 1, 0.01],
  'steering.lockDeg': [5, 45, 0.5],
  'steering.lockFalloffKph': [20, 600, 5],
  'input.steerRate': [0.5, 30, 0.1],
  'input.steerReturnRate': [0.5, 30, 0.1],
  'input.throttleRate': [0.5, 30, 0.1],
  'input.brakeRate': [0.5, 30, 0.1],
  'wear.throttlePerSec': [0, 0.05, 0.0001],
  'wear.throttleLowSpeedKph': [5, 300, 1],
  'wear.brakePerSec': [0, 0.02, 0.0001],
  'wear.cornerPerSec': [0, 0.01, 0.00005],
  'wear.refSpeedKph': [50, 400, 1],
  'fuel.tankKg': [10, 200, 1],
  'fuel.startKg': [0, 200, 1],
  'fuel.burnKgPerSec': [0, 3, 0.01],
  'fuel.refuelKgPerSec': [0, 50, 0.5],
  'fuel.pitServiceMaxKph': [0, 20, 0.5],
  'walls.restitution': [0, 1, 0.01],
  'walls.friction': [0, 1.5, 0.01],
  'walls.barrierScrubPerSec': [0, 10, 0.05],
  'solver.velocityIterations': [1, 20, 1],
  'solver.positionIterations': [1, 20, 1],
  'rules.pitSpeedLimitKph': [20, 150, 1],
  'surface.grip': [0, 1.5, 0.01],
  'surface.rollingDrag': [0, 1.5, 0.005],
  'audio.engine.gears': [3, 10, 1],
  'audio.engine.idleRpm': [1000, 10000, 50],
  'audio.engine.maxRpm': [6000, 20000, 50],
  'audio.engine.shiftRpm': [3000, 18000, 50],
  'audio.engine.gearSpread': [0.3, 1.5, 0.01],
  'audio.engine.cylinders': [2, 16, 2],
  'audio.tyres.squealCurve': [0.2, 3, 0.05],
};

const LABELS: Record<string, string> = {
  car: 'Car body', engine: 'Engine', brakes: 'Brakes', aero: 'Aero (drag = c·v², grip × (1 + k·v²))',
  tyres: 'Tyres', steering: 'Steering', input: 'Input ramps (per second)', wear: 'Tyre wear',
  fuel: 'Fuel + pit', walls: 'Walls', solver: 'Solver',
};

export interface TuningTargets {
  physics: PhysicsConfig;
  /** The whole surfaces.json object (its other keys are saved back untouched). */
  surfacesConfig: { surfaces: SurfaceDef[] };
  rules: Rules;
  /** config/vfx.json, live. */
  vfx: VfxConfig;
  vfxQuality: { get(): VfxQuality; set(q: VfxQuality): void; clear(): void };
  /** config/audio.json, live. */
  audio: AudioConfig;
  volumes: { values: Volumes; set(bus: 'master' | 'engine' | 'tyres' | 'impacts' | 'ui', v: number): void };
  /** Called when the team/spec/setup changes, to rebuild the player's car. */
  onBuildChange(build: CarBuild): void;
}

async function saveConfig(name: 'physics' | 'surfaces' | 'rules' | 'vfx' | 'audio', value: unknown): Promise<string> {
  const res = await fetch(`/__tuning/save/${name}`, { method: 'POST', headers: { 'x-tuning-panel': '1' }, body: formatTrackJson(value) });
  return res.ok ? `config/${name}.json` : `${name}: ${await res.text()}`;
}

export class TuningPanel {
  private readonly gui: GUI;
  private readonly telemetry: HTMLElement;
  private readonly saved: { physics: PhysicsConfig; surfacesConfig: { surfaces: SurfaceDef[] }; rules: Rules };
  private lastTelemetry = 0;
  visible = false;

  constructor(private readonly t: TuningTargets) {
    this.saved = structuredClone({ physics: t.physics, surfacesConfig: t.surfacesConfig, rules: t.rules });
    this.gui = new GUI({ title: 'Tuning (T to hide)', width: 330 });
    this.gui.domElement.classList.add('tuning-gui');
    this.build();
    this.telemetry = document.createElement('div');
    this.telemetry.className = 'telemetry';
    document.body.appendChild(this.telemetry);
    this.setVisible(false);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyT' && !(e.target instanceof HTMLInputElement)) this.setVisible(!this.visible);
    });
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.gui.show(v);
    this.telemetry.style.display = v ? '' : 'none';
  }

  private slider(folder: GUI, obj: object, key: string, rangeKey: string, label = key): Controller {
    const v = (obj as Record<string, number>)[key]!;
    const [min, max, stp] = RANGES[rangeKey] ?? [0, Math.max(1, Math.abs(v) * 3), Math.abs(v) / 100 || 0.01];
    return folder.add(obj as Record<string, number>, key, Math.min(min, v), Math.max(max, v), stp).name(label);
  }

  private build(): void {
    const { physics, rules } = this.t;
    const { surfaces } = this.t.surfacesConfig;
    const gui = this.gui;

    // Which car: team x spec x setup.
    const car = gui.addFolder('Car (team × spec × setup)');
    const sel = structuredClone(physics.defaultCar);
    const changed = () => this.t.onBuildChange(structuredClone(sel));
    car.add(sel, 'team', Object.fromEntries(catalog.teams.map((t) => [t.name, t.id]))).onChange(changed);
    car.add(sel, 'spec', Object.keys(catalog.specs.specs)).onChange(changed);
    for (const slot of Object.keys(sel.setup) as Array<keyof CarBuild['setup']>)
      car.add(sel.setup, slot, Object.keys(catalog.specs.setups[slot] ?? {})).name(`setup: ${slot}`).onChange(changed);
    car.add({ makeDefault: () => (physics.defaultCar = structuredClone(sel)) }, 'makeDefault').name('Use as default car (then Save)');

    for (const [section, values] of Object.entries(physics)) {
      if (section === 'defaultCar' || typeof values !== 'object') continue;
      const f = gui.addFolder(LABELS[section] ?? section);
      for (const key of Object.keys(values as object)) this.slider(f, values as object, key, `${section}.${key}`);
      f.close();
    }

    const r = gui.addFolder('Rules');
    this.slider(r, rules, 'pitSpeedLimitKph', 'rules.pitSpeedLimitKph', 'pit limit kph');
    r.close();

    const s = gui.addFolder('Surfaces (per wheel)');
    for (const surf of surfaces) {
      if (['wall', 'tyreBarrier', 'outOfBounds'].includes(surf.id)) continue;
      this.slider(s, surf, 'grip', 'surface.grip', `${surf.id} grip`);
      this.slider(s, surf, 'rollingDrag', 'surface.rollingDrag', `${surf.id} drag`);
    }
    s.close();

    const v = gui.addFolder('Tyre VFX (V cycles quality)');
    const q = { quality: this.t.vfxQuality.get() };
    v.add(q, 'quality', ['off', 'low', 'high']).onChange((x: VfxQuality) => this.t.vfxQuality.set(x)).listen();
    v.add({ clear: () => this.t.vfxQuality.clear() }, 'clear').name('Clear marks + rubber (green track)');
    for (const [section, values] of Object.entries(this.t.vfx)) {
      if (typeof values === 'number') { this.slider(v, this.t.vfx, section, `vfx.${section}`); continue; }
      if (typeof values !== 'object') continue;
      const sub = v.addFolder(section);
      for (const key of Object.keys(values as object)) this.slider(sub, values as object, key, `vfx.${section}.${key}`);
      sub.close();
    }
    v.close();
    setInterval(() => (q.quality = this.t.vfxQuality.get()), 500);

    const snd = gui.addFolder('Sound (M mutes)');
    const vol = snd.addFolder('Volumes (saved in this browser)');
    for (const bus of ['master', 'engine', 'tyres', 'impacts', 'ui'] as const)
      vol.add(this.t.volumes.values, bus, 0, 1, 0.01).onChange((x: number) => this.t.volumes.set(bus, x));
    for (const [section, values] of Object.entries(this.t.audio)) {
      if (section === 'files' || section === 'defaultVolumes' || typeof values !== 'object' || !values) continue;
      const sub = snd.addFolder(section);
      for (const [key, val] of Object.entries(values as object)) if (typeof val === 'number') this.slider(sub, values as object, key, `audio.${section}.${key}`);
      sub.close();
    }
    snd.close();

    const io = gui.addFolder('Save / export');
    const status = { msg: '' };
    const show = (m: string) => {
      status.msg = m;
      statusCtl.updateDisplay();
    };
    io.add({
      save: async () => show('Saved ' + (await Promise.all([saveConfig('physics', physics), saveConfig('surfaces', this.t.surfacesConfig), saveConfig('rules', rules), saveConfig('vfx', this.t.vfx), saveConfig('audio', this.t.audio)])).join(', ')),
    }, 'save').name('Save to /config');
    io.add({ copy: () => void navigator.clipboard.writeText(formatTrackJson(physics)).then(() => show('physics.json copied')) }, 'copy').name('Copy physics JSON');
    io.add({ revert: () => this.revert() && show('Reverted to last saved values') }, 'revert').name('Revert unsaved changes');
    const statusCtl = io.add(status, 'msg').name('status').disable();
  }

  private revert(): true {
    const copyInto = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(src)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) copyInto(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
        else dst[k] = structuredClone(v);
      }
    };
    copyInto(this.t.physics as unknown as Record<string, unknown>, this.saved.physics as unknown as Record<string, unknown>);
    this.t.surfacesConfig.surfaces.forEach((s, i) => Object.assign(s, this.saved.surfacesConfig.surfaces[i]));
    Object.assign(this.t.rules, this.saved.rules);
    for (const c of this.gui.controllersRecursive()) c.updateDisplay();
    return true;
  }

  /** Telemetry for car 0, refreshed ~10x a second while the panel is open. */
  update(world: WorldState, surfaces: readonly SurfaceDef[], physics: PhysicsConfig): void {
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.lastTelemetry < 100) return;
    this.lastTelemetry = now;
    const c = world.cars[0];
    if (!c) return;
    const kph = (c.speed * 3.6).toFixed(0);
    const bar = (v: number) => '█'.repeat(Math.round(v * 10)).padEnd(10, '·');
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
    const names = ['FL', 'FR', 'RL', 'RR'];
    const rows = c.wheels
      .map((w, i) => {
        const sliding = w.usage > 1 ? ' class="slide"' : '';
        return `<tr><td>${names[i]}</td><td>${surfaces[w.surface]?.id ?? '?'}</td><td>${pct(w.wear)}</td><td>${w.slipDeg.toFixed(1)}°</td><td${sliding}>${pct(Math.min(w.usage, 9.99))}</td><td>${(w.gripN / 1000).toFixed(1)}</td><td>${(w.loadN / 1000).toFixed(1)}</td></tr>`;
      })
      .join('');
    const flags = [c.inPitLane && 'PIT LIMITER', c.inPitBox && 'PIT BOX', c.offTrack && 'OFF TRACK', c.wallContact && 'WALL', c.barrierContact && 'BARRIER']
      .filter(Boolean)
      .join(' · ');
    this.telemetry.innerHTML = `
      <div class="speed">${kph} <small>kph</small></div>
      <div>throttle ${bar(c.controls.throttle)}  brake ${bar(c.controls.brake)}</div>
      <div>steer ${c.controls.steer >= 0 ? '+' : ''}${c.controls.steer.toFixed(2)}   yaw ${(c.angVel * 57.3).toFixed(0)}°/s</div>
      <div>fuel ${c.fuelKg.toFixed(1)} kg (${pct(c.fuelKg / physics.fuel.tankKg)})   mass ${(physics.car.dryMassKg + c.fuelKg).toFixed(0)} kg</div>
      <table><tr><th></th><th>surface</th><th>wear</th><th>slip</th><th>use</th><th>grip kN</th><th>load kN</th></tr>${rows}</table>
      <div class="flags">${flags || '&nbsp;'}</div>`;
  }
}

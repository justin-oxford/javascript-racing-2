// Game audio (Web Audio). Synthesized placeholders for every layer; set config/audio.json files.<name>
// to a sample path and that layer plays the sample instead, no code change. Continuous layers are built
// once and only have their parameters moved; one-shots (impacts, beeps, crackle) reuse fixed filter/gain
// chains and create only the source node each event needs.
import type { AudioConfig, SoundTargets } from './targets';

type Bus = 'master' | 'engine' | 'tyres' | 'impacts' | 'ui';
export type Volumes = Record<Bus, number> & { muted: boolean };
const STORE_KEY = 'jsr.audio';
const SMOOTH = 0.03; // seconds: parameter glide, avoids zipper noise

function loadVolumes(defaults: AudioConfig['defaultVolumes']): Volumes {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Volumes> | null;
    if (v) return { ...defaults, muted: false, ...v };
  } catch {
    // blocked or corrupt: defaults
  }
  return { ...defaults, muted: false };
}

interface Loop {
  out: GainNode;
  /** Pitch as a multiple of the layer's base. */
  setPitch?(ratio: number, at: number): void;
}

export class GameAudio {
  readonly volumes: Volumes;
  private ctx: AudioContext | undefined;
  private bus = {} as Record<Bus, GainNode>;
  private noise!: AudioBuffer;
  private samples = new Map<string, AudioBuffer>();
  private eng!: { oscs: OscillatorNode[]; sample?: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; limiterDepth: GainNode };
  private loops = {} as Record<'squeal' | 'lockup' | 'wheelspin' | 'kerb' | 'gravel' | 'grass', Loop>;
  private kerbLfo!: OscillatorNode;
  private squealOsc: OscillatorNode | undefined;
  private hit = {} as Record<'wall' | 'barrier' | 'car', { filter: BiquadFilterNode; gain: GainNode; last: number }>;
  private crackleChain!: { filter: BiquadFilterNode; gain: GainNode };
  private readonly lastTarget = new WeakMap<AudioParam, number>();

  constructor(private readonly cfg: AudioConfig) {
    this.volumes = loadVolumes(cfg.defaultVolumes);
    // Browsers only allow audio after a user gesture: start on the first key or click.
    const start = () => void this.start();
    window.addEventListener('keydown', start, { once: true });
    window.addEventListener('pointerdown', start, { once: true });
    // Don't drone on in a background tab while the game loop is paused.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** For tests/benchmarks: the master bus (connect an analyser to it). */
  get output(): AudioNode | undefined {
    return this.bus.master;
  }

  get context(): AudioContext | undefined {
    return this.ctx;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    for (const b of ['master', 'engine', 'tyres', 'impacts', 'ui'] as Bus[]) this.bus[b] = ctx.createGain();
    for (const b of ['engine', 'tyres', 'impacts', 'ui'] as Bus[]) this.bus[b].connect(this.bus.master);
    this.bus.master.connect(ctx.destination);
    this.applyVolumes();

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    await this.loadSamples();
    this.buildEngine();
    this.buildTyres();
    this.buildOneShots();
    if (ctx.state !== 'running') await ctx.resume();
  }

  private async loadSamples(): Promise<void> {
    const ctx = this.ctx!;
    await Promise.all(
      Object.entries(this.cfg.files).map(async ([name, path]) => {
        if (!path) return;
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
          this.samples.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch (e) {
          console.warn(`[audio] couldn't load ${path} for "${name}"; using the synth placeholder`, e);
        }
      }),
    );
  }

  private noiseSource(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start();
    return s;
  }

  private filter(type: BiquadFilterType, hz: number, q = 1): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    return f;
  }

  private gain(v = 0): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = v;
    return g;
  }

  /** A sample loop for `name` if one is configured, routed into `out`. */
  private sampleLoop(name: string, out: AudioNode): AudioBufferSourceNode | undefined {
    const buf = this.samples.get(name);
    if (!buf) return undefined;
    const s = this.ctx!.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(out);
    s.start();
    return s;
  }

  private buildEngine(): void {
    const ctx = this.ctx!;
    const filter = this.filter('lowpass', this.cfg.engine.liftCutoffHz, 0.9);
    const gain = this.gain(0);
    // Limiter stutter: an LFO pushes the gain up and down when engaged (depth 0 otherwise).
    const am = this.gain(1);
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = this.cfg.engine.limiterHz;
    const limiterDepth = this.gain(0);
    lfo.connect(limiterDepth).connect(am.gain);
    lfo.start();
    filter.connect(gain).connect(am).connect(this.bus.engine);

    const sample = this.sampleLoop('engine', filter);
    const oscs: OscillatorNode[] = [];
    if (!sample) {
      // Thin placeholder: firing-frequency saw + sub square + detuned octave saw.
      for (const [type, mult, level] of [['sawtooth', 1, 0.5], ['square', 0.5, 0.25], ['sawtooth', 2.01, 0.15]] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = 100 * mult;
        const g = this.gain(level);
        o.connect(g).connect(filter);
        o.start();
        (o as OscillatorNode & { mult: number }).mult = mult;
        oscs.push(o);
      }
    }
    this.eng = { oscs, ...(sample ? { sample } : {}), filter, gain, limiterDepth };
  }

  private buildTyres(): void {
    const ctx = this.ctx!;
    const mk = (name: keyof typeof this.loops, synth: (out: GainNode) => void, base?: number): void => {
      const out = this.gain(0);
      out.connect(this.bus.tyres);
      const sample = this.sampleLoop(name, out);
      if (!sample) synth(out);
      this.loops[name] = {
        out,
        ...(sample ? { setPitch: (r: number, at: number) => sample.playbackRate.setTargetAtTime(r, at, SMOOTH) } : {}),
      };
      void base;
    };

    // Squeal: tonal and high, with a little vibrato. Pitch rises with how far over the limit.
    mk('squeal', (out) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = this.cfg.tyres.squealBaseHz;
      const vib = ctx.createOscillator();
      vib.frequency.value = 7;
      const vibDepth = this.gain(18);
      vib.connect(vibDepth).connect(o.frequency);
      const n = this.noiseSource();
      const bp = this.filter('bandpass', this.cfg.tyres.squealBaseHz * 2.2, 9);
      const g1 = this.gain(0.6), g2 = this.gain(0.5);
      o.connect(g1).connect(out);
      n.connect(bp).connect(g2).connect(out);
      o.start();
      vib.start();
      this.squealOsc = o;
    });
    // Lockup: flat, harsh, broadband scrape plus a low buzz. Clearly not the squeal.
    mk('lockup', (out) => {
      const n = this.noiseSource();
      const bp = this.filter('bandpass', 750, 0.6);
      const hp = this.filter('highpass', 3200, 0.7);
      const buzz = ctx.createOscillator();
      buzz.type = 'square';
      buzz.frequency.value = 170;
      const gb = this.gain(0.12), gn = this.gain(0.8), gh = this.gain(0.35);
      n.connect(bp).connect(gn).connect(out);
      n.connect(hp).connect(gh).connect(out);
      buzz.connect(gb).connect(out);
      buzz.start();
    });
    // Wheelspin: low scrabble, chopped.
    mk('wheelspin', (out) => {
      const n = this.noiseSource();
      const bp = this.filter('bandpass', 420, 1.4);
      const chop = this.gain(0.6);
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 23;
      const depth = this.gain(0.4);
      lfo.connect(depth).connect(chop.gain);
      lfo.start();
      n.connect(bp).connect(chop).connect(out);
    });
    // Kerb: low rumble pulsed at stripes-per-second.
    mk('kerb', (out) => {
      const n = this.noiseSource();
      const lp = this.filter('lowpass', 260, 0.8);
      const thump = ctx.createOscillator();
      thump.frequency.value = 62;
      const pulse = this.gain(0.5);
      this.kerbLfo = ctx.createOscillator();
      this.kerbLfo.type = 'square';
      this.kerbLfo.frequency.value = 10;
      const depth = this.gain(0.5);
      this.kerbLfo.connect(depth).connect(pulse.gain);
      this.kerbLfo.start();
      const gt = this.gain(0.6);
      n.connect(lp).connect(pulse);
      thump.connect(gt).connect(pulse);
      pulse.connect(out);
      thump.start();
    });
    // Gravel: bright, gritty crunch.
    mk('gravel', (out) => {
      const n = this.noiseSource();
      const hp = this.filter('highpass', 1700, 0.8);
      const grit = this.gain(0.6);
      const lfo = ctx.createOscillator();
      lfo.type = 'sawtooth';
      lfo.frequency.value = 37;
      const depth = this.gain(0.4);
      lfo.connect(depth).connect(grit.gain);
      lfo.start();
      n.connect(hp).connect(grit).connect(out);
    });
    // Grass: soft low rumble.
    mk('grass', (out) => {
      const n = this.noiseSource();
      n.connect(this.filter('lowpass', 170, 0.7)).connect(out);
    });
  }

  private buildOneShots(): void {
    for (const [kind, hz] of [['wall', 1400], ['barrier', 380], ['car', 900]] as const) {
      const filter = this.filter('lowpass', hz, 0.7);
      const gain = this.gain(0);
      filter.connect(gain).connect(this.bus.impacts);
      this.hit[kind] = { filter, gain, last: -1 };
    }
    const filter = this.filter('highpass', 1500, 0.7);
    const gain = this.gain(0.5);
    filter.connect(gain).connect(this.bus.engine);
    this.crackleChain = { filter, gain };
  }

  /** Short noise burst + body thump, through the kind's reused chain. */
  private impact(kind: 'wall' | 'barrier' | 'car', strength: number): void {
    const ctx = this.ctx!;
    const h = this.hit[kind];
    const now = ctx.currentTime;
    if (now - h.last < this.cfg.impacts.cooldownSec) return;
    h.last = now;
    const level = strength * this.cfg.impacts[`${kind}Gain`];
    const decay = kind === 'barrier' ? 0.35 : kind === 'wall' ? 0.22 : 0.15;
    h.gain.gain.cancelScheduledValues(now);
    h.gain.gain.setValueAtTime(level, now);
    h.gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    const sample = this.samples.get(kind === 'car' ? 'carBump' : kind);
    const src = ctx.createBufferSource();
    src.buffer = sample ?? this.noise;
    src.connect(h.filter);
    src.start(now, sample ? 0 : Math.random(), sample ? undefined : decay);
    if (!sample && kind !== 'car') {
      const thump = ctx.createOscillator();
      thump.frequency.setValueAtTime(kind === 'wall' ? 85 : 55, now);
      thump.frequency.exponentialRampToValueAtTime(35, now + decay);
      thump.connect(h.filter);
      thump.start(now);
      thump.stop(now + decay);
    }
  }

  private crackle(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      if (Math.random() > this.cfg.engine.crackle) continue;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.connect(this.crackleChain.filter);
      src.start(now + Math.random() * 0.5, Math.random(), 0.012 + Math.random() * 0.02);
    }
  }

  private beep(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    for (const t of [0, 0.12]) {
      const o = ctx.createOscillator();
      o.frequency.value = this.cfg.pit.beepHz;
      const g = this.gain(0);
      g.gain.setValueAtTime(0, now + t);
      g.gain.linearRampToValueAtTime(this.cfg.pit.beepGain, now + t + 0.005);
      g.gain.setTargetAtTime(0, now + t + 0.06, 0.01);
      o.connect(g).connect(this.bus.ui);
      o.start(now + t);
      o.stop(now + t + 0.12);
    }
  }

  /** Called every sim tick with the player's car's targets. */
  update(t: SoundTargets): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.eng) return;
    const now = this.ctx.currentTime;
    const e = this.cfg.engine;
    // Only automate a parameter when its target really moves. Scheduling ~20 setTargetAtTime events
    // every tick regardless piles work onto the audio thread in some browsers.
    const set = (p: AudioParam, v: number) => {
      const last = this.lastTarget.get(p);
      if (last !== undefined && Math.abs(v - last) <= 1e-3 * Math.max(1, Math.abs(last))) return;
      this.lastTarget.set(p, v);
      p.cancelScheduledValues(now);
      p.setTargetAtTime(v, now, SMOOTH);
    };

    // Engine.
    const fire = (t.engine.rpm / 60) * (e.cylinders / 2);
    for (const o of this.eng.oscs) set(o.frequency, fire * (o as OscillatorNode & { mult: number }).mult);
    if (this.eng.sample) set(this.eng.sample.playbackRate, t.engine.rpm / this.cfg.sampleBaseRpm.engine);
    const on = t.engine.throttle;
    set(this.eng.filter.frequency, e.liftCutoffHz + (e.throttleCutoffHz - e.liftCutoffHz) * on);
    set(this.eng.gain.gain, e.liftGain + (1 - e.liftGain) * on);
    set(this.eng.limiterDepth.gain, t.engine.limiter ? 0.5 : 0);
    if (t.engine.lift && t.engine.rpm > e.shiftRpm) this.crackle();

    // Tyres + surfaces.
    const tc = this.cfg.tyres, sc = this.cfg.surfaces;
    set(this.loops.squeal.out.gain, t.squeal * tc.squealGain);
    if (this.squealOsc) set(this.squealOsc.frequency, tc.squealBaseHz * t.squealPitch);
    this.loops.squeal.setPitch?.(t.squealPitch, now);
    set(this.loops.lockup.out.gain, t.lockup * tc.lockupGain);
    set(this.loops.wheelspin.out.gain, t.wheelspin * tc.wheelspinGain);
    set(this.loops.kerb.out.gain, t.kerb * sc.kerbGain);
    if (this.kerbLfo) set(this.kerbLfo.frequency, Math.max(1, t.kerbPulseHz));
    set(this.loops.gravel.out.gain, t.gravel * sc.gravelGain);
    set(this.loops.grass.out.gain, t.grass * sc.grassGain);

    for (const i of t.impacts) this.impact(i.kind, i.strength);
    if (t.pitBeep) this.beep();
  }

  // ---- volumes ----

  setVolume(bus: Bus, v: number): void {
    this.volumes[bus] = v;
    this.applyVolumes();
  }

  toggleMute(): boolean {
    this.volumes.muted = !this.volumes.muted;
    this.applyVolumes();
    return this.volumes.muted;
  }

  private applyVolumes(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.volumes));
    } catch {
      // not persisted; fine
    }
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const b of ['engine', 'tyres', 'impacts', 'ui'] as Bus[]) this.bus[b].gain.setTargetAtTime(this.volumes[b], now, SMOOTH);
    this.bus.master.gain.setTargetAtTime(this.volumes.muted ? 0 : this.volumes.master, now, SMOOTH);
  }
}

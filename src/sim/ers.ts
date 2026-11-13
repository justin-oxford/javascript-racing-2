// Engine modes + battery deploy (POLISH card). Deliberately simple: three engine modes that trade power for
// fuel, and one deploy button that spends battery charge (harvested under braking) as extra power, capped
// per lap. Plain data on the car; the mode request and the deploy flag come in the car's input.

export type EngineMode = 'save' | 'standard' | 'push';
export const ENGINE_MODES: readonly EngineMode[] = ['save', 'standard', 'push'];

/** config/ers.json. */
export interface ErsConfig {
  modes: Record<EngineMode, { power: number; fuel: number }>;
  battery: { capacityKJ: number; harvestShare: number; deployKW: number; maxDeployPerLapKJ: number; startPct: number };
}

/** Per-car engine mode and battery. */
export interface ErsState {
  mode: EngineMode;
  /** Charge, kJ. */
  batteryKJ: number;
  /** Deployed since the car last crossed the line, kJ. */
  lapDeployKJ: number;
  /** Deploying this tick (HUD glow, AI reporting). */
  deploying: boolean;
  /** timing.laps when lapDeployKJ was last reset. */
  lap: number;
}

export const newErs = (cfg: ErsConfig): ErsState => ({ mode: 'standard', batteryKJ: cfg.battery.capacityKJ * cfg.battery.startPct, lapDeployKJ: 0, deploying: false, lap: 0 });

export const nextEngineMode = (m: EngineMode): EngineMode => ENGINE_MODES[(ENGINE_MODES.indexOf(m) + 1) % ENGINE_MODES.length]!;

/** Extra power this tick, watts: deploy held, throttle on, charge left, lap budget left. */
export function deployPowerW(ers: ErsState, wantDeploy: boolean, throttle: number, cfg: ErsConfig): number {
  const b = cfg.battery;
  if (!wantDeploy || throttle <= 0.05 || ers.batteryKJ <= 0 || ers.lapDeployKJ >= b.maxDeployPerLapKJ) return 0;
  return b.deployKW * 1000 * throttle;
}

/** After the tick: spend what was deployed, harvest a share of the braking power, reset the lap budget at the line. */
export function updateErs(ers: ErsState, mode: EngineMode, deployW: number, brakePowerW: number, laps: number, dt: number, cfg: ErsConfig): ErsState {
  const b = cfg.battery;
  const spent = (deployW * dt) / 1000, gained = (Math.max(0, brakePowerW) * b.harvestShare * dt) / 1000;
  const newLap = laps !== ers.lap;
  return {
    mode,
    batteryKJ: Math.max(0, Math.min(b.capacityKJ, ers.batteryKJ - spent + gained)),
    lapDeployKJ: newLap ? 0 : ers.lapDeployKJ + spent,
    deploying: deployW > 0,
    lap: laps,
  };
}

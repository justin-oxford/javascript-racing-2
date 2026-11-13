// The pit board (Race strategy card): what the next stop does, set from the keyboard while driving.
// Shown for a few seconds after a pit key, and all the time in the pit lane. Pure: plan in, HTML out.
import { FUEL_TO_END, type CarState, type PitPlan, type StrategyConfig } from '../../sim';
import { keyLabel, type Keybinds } from '../menu/keybinds';

const key = (b: Keybinds, a: keyof Keybinds): string => (b[a][0] ? keyLabel(b[a][0]) : '-');

/** "TO END" or "+15 kg". */
export const fuelText = (plan: PitPlan): string => (plan.fuelKg === FUEL_TO_END ? 'TO END' : `+${Math.round(plan.fuelKg)} kg`);

export function pitBoardHtml(plan: PitPlan, cfg: StrategyConfig, binds: Keybinds, car: Pick<CarState, 'stop' | 'fuelKg' | 'servicing'>, repairAvailable: boolean): string {
  const keyOf = { soft: 'pitSoft', medium: 'pitMedium', hard: 'pitHard', inter: 'pitInter', wet: 'pitWet' } as const;
  const tyres = (['soft', 'medium', 'hard', 'inter', 'wet'] as const).filter((c) => cfg.compounds[c]).map((c) => {
    const d = cfg.compounds[c], on = plan.tyres && plan.compound === c;
    return `<span class="cmp${on ? ' on' : ''}" style="--c:${d.color}">${d.letter}<i>${key(binds, keyOf[c])}</i></span>`;
  }).join('');
  const rows = [
    `<div class="row"><span class="k">TYRES</span>${tyres}<span class="tog${plan.tyres ? ' on' : ''}">${plan.tyres ? 'CHANGE' : 'KEEP'}<i>${key(binds, 'pitTyres')}</i></span></div>`,
    `<div class="row"><span class="k">FUEL</span><span class="v">${fuelText(plan)}</span><i>${key(binds, 'pitFuelDown')} / ${key(binds, 'pitFuelUp')}</i></div>`,
    repairAvailable ? `<div class="row"><span class="k">REPAIR</span><span class="tog${plan.repair ? ' on' : ''}">${plan.repair ? 'YES' : 'NO'}<i>${key(binds, 'pitRepair')}</i></span></div>` : '',
  ];
  // In the box: what's left of the stop.
  const s = car.servicing ? car.stop : null;
  const work = s ? `<div class="row stop">IN BOX: ${s.fitting ? `tyres ${s.tyreLeftSec.toFixed(1)} s` : 'tyres done'} · fuel ${Math.round(car.fuelKg)} / ${Math.round(s.fuelToKg)} kg${s.repair ? ' · repairing' : ''}</div>` : '';
  return `<div class="title">NEXT STOP</div>${rows.join('')}${work}`;
}

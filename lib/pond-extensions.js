// Treasury Waters extension for Personal Pond.
import { POND_TREASURY_PERKS } from './pond.js';

export const POND_TREASURY_MODE_ID = 'treasuryWaters';
export const POND_TREASURY_MODE_LEVEL = 5;
export const POND_TREASURY_MODE_COST = 250;

if (!POND_TREASURY_PERKS[POND_TREASURY_MODE_ID]) {
  POND_TREASURY_PERKS[POND_TREASURY_MODE_ID] = {
    label: 'Treasury Waters',
    max: 1,
    costs: [POND_TREASURY_MODE_COST],
    desc: 'At Pond Level 5, changes the Pond into Treasury-only mode. Pond catches go straight to inventory as Treasury loot.',
    requiresPondLevel: POND_TREASURY_MODE_LEVEL,
    mode: 'treasury-only'
  };
}

export function treasuryPondPool(tiers) {
  const tier = (Array.isArray(tiers) ? tiers : []).find((entry) => entry?.id === 'treasury');
  return (tier?.items || []).filter((item) => !/timeout/i.test(String(item)));
}

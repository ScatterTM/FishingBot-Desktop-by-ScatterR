// Master loot table. Single source of truth: api/fish.js (the !fish
// roll itself), api/fishdex.js and api/leaderboard.js all import this
// module instead of HTTP-fetching /api/fish?action=tiers from themselves.
// That self-fetch trusted the Host header and cost two HTTPS round trips
// per call; a direct import can do neither of those things.
//
// The public shape is unchanged: GET /api/fish?action=tiers still serves
// this exact array, so the site, the preview fixtures and the bundled
// defaultTiersConfig in index.html all describe the same table.

const DEFAULT_TIERS = [
  { id: 'unique', name: 'SECRET', badge: 'SECRET', cutoff: 0, rankScore: 8, basePct: 0.0, items: ['Webcamfish', 'conquerorfish', 'RAGEfish', 'Betatestfish'] },
  { id: 'godly', name: 'GODLY', badge: 'GODLY', cutoff: 0.0001, rankScore: 7, basePct: 0.01, items: ['Vipfish (gives VIP role)', 'Cthulu (choose to end stream or not)', 'Starfish King', 'Moonfish', 'Cosmic Jellyfish', 'The Ancient Leviathan'] },
  { id: 'legendary', name: 'LEGENDARY', badge: 'LEGENDARY', cutoff: 0.0051, rankScore: 6, basePct: 0.5, items: ['1.5x Luck (permanent)', 'Raidfish (control the raid)', 'Squidink (run ad break)', 'Salesmanfish (free channel point redeem)', 'Badmapfish (free skip bad map)', 'GRANDPA?? (10s chat slowmode for 5m)', 'Golden Fish', 'Crystal Fish', 'Rainbow Fish', 'Ghost Fish', 'Lava Fish', 'Ice Fish'] },
  { id: 'epic', name: 'EPIC', badge: 'EPIC', cutoff: 0.0151, rankScore: 5, basePct: 1.0, items: ['Timesomeoneoutfor1minutefish', '240kfish (plays nick raid song)', 'Shieldfish (protect from next timeout)', 'Freesongrequestfish', '2x Luck (Lasts 10 minutes)', 'Great White Shark', 'Hammerhead Shark', 'Tiger Shark', 'Manta Ray', 'Giant Squid', 'Nautilus', 'Horseshoe Crab', 'Lobster', 'Giant Crab', 'Blue Lobster', 'Vampire Squid', 'Whale Shark', 'Oarfish', 'Coelacanth', 'Deep-Sea Dragonfish', 'Goblin Shark', 'Sawfish', 'Electric Ray', 'Sea Turtle'] },
  { id: 'rare', name: 'RARE', badge: 'RARE', cutoff: 0.0651, rankScore: 3, basePct: 5.0, items: ['kendricklamaar', 'dogwithdacoolglasses', 'duckwithflowerhat', 'cockfish', 'peekayfish', 'trackmaniacar', 'slashedfish', 'intaxfish', 'biblo', 'joel', 'scatterrfish', 'shark', 'Aethfish', 'ibrafish', 'creavesfish (smelly creaves)', 'anglerfish', 'deepseadiver', 'ninjafish', 'goldfish', 'titanic', 'giantoceanicmantaray', 'walterwhite', '240nickscarbonnet', 'thebloop', 'Arctic Char', 'Tiger Trout', 'Koi', 'Electric Eel', 'Pufferfish', 'Lionfish', 'Angelfish', 'Triggerfish', 'Butterflyfish', 'Parrotfish', 'Swordfish', 'Tuna'] },
  { id: 'uncommon', name: 'UNCOMMON', badge: 'UNCOMMON', cutoff: 0.3151, rankScore: 2, basePct: 25.0, items: ['Barracuda', 'KoiKoi fish', 'Speedrunnerfish', 'Grouper', 'Snapper', 'Moray Eel', 'Flying Fish', 'Lanternfish', 'Needlefish', 'Stingray', 'Octopus', 'bass', 'trout', 'boot', 'shrimp', 'pollock', 'schmish', 'bottleofjoe', 'duck', 'duckling', 'nemo', 'clownfish', 'tropicalfish', 'catfish', 'dogfish', 'fischfish', 'yabbfish', 'mackerel', 'roosterfish', 'copper', 'axolotl', 'salmon', 'robertlogia', 'frog', 'deutschlandfish', 'squid', 'neofish', 'oldertimer', 'petahfihh', 'tntfish'] },
  { id: 'common', name: 'COMMON', badge: 'COMMON', cutoff: 1.0, rankScore: 1, basePct: 68.49, isCommon: true, items: ['baldcap', 'weave', 'toupe', 'seaweed', 'weed', 'jellyfish', 'hook', 'seahorse', 'humanfoot', 'deadrat', 'aliverat', 'greggssausageroll', 'trash', 'tasselledwobbegong', 'redlippedbatfish', 'aspenfish', 'tylersmayhem', 'Bluegill', 'Smallmouth Bass', 'Largemouth Bass', 'Common Carp', 'Minnow', 'Perch', 'Roach', 'Sardine', 'Anchovy', 'Herring', 'Cod', 'Haddock', 'Flounder', 'Mullet', 'Smelt', 'Pike', 'Walleye', 'Sunfish', 'Crappie', 'Eel'] },
  { id: 'treasury', name: 'TREASURY', badge: 'TREASURY', rankScore: 4, basePct: 2.0, luckImmune: true, items: ['Seamine (10min timeout)', 'Soggyboot (self-timeout 5m)', 'Rusty Boot', 'Old Fishing Rod', 'Lost Wallet', 'Glass Bottle', 'Message in a Bottle', 'Pirate Coin', 'Silver Coin', 'Gold Coin', 'Ancient Coin', 'Pearl', 'Black Pearl', 'Emerald', 'Ruby', 'Sapphire', 'Golden Ring', 'Ancient Crown', 'Pirate Compass', 'Treasure Map', "Ship's Anchor", 'Golden Anchor', 'gold', 'silver', 'bronze'] }
];

// Local edition customisation. The defaults above remain the source for the
// legacy hosted edition; the local streamer may override item names
// and rarity odds through the desktop Control Centre. The config is loaded at
// process start so every module sees one consistent catalogue.
import fs from 'node:fs';
import path from 'node:path';

function loadLocalTiers() {
  if (process.env.LOCAL_EDITION !== '1') return DEFAULT_TIERS;
  const file = process.env.LOCAL_LOOT_TABLE_PATH || path.resolve(process.cwd(), 'data', 'loot-table.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(saved?.tiers)) return DEFAULT_TIERS;
    return DEFAULT_TIERS.map((tier) => {
      const override = saved.tiers.find((entry) => entry?.id === tier.id);
      if (!override) return tier;
      const items = Array.isArray(override.items) ? override.items.map((value) => String(value).trim()).filter(Boolean) : tier.items;
      const next = { ...tier, items };
      if (Number.isFinite(Number(override.cutoff)) && tier.id !== 'treasury') next.cutoff = Number(override.cutoff);
      if (Number.isFinite(Number(override.basePct))) next.basePct = Number(override.basePct);
      return next;
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[settings] Could not load custom loot table; using defaults:', error?.message || error);
    return DEFAULT_TIERS;
  }
}

export const TIERS = loadLocalTiers();

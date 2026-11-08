import baseHandler from '../lib/site-base.js';
import { TIERS } from '../lib/tiers.js';
import { fishWeightTable } from '../lib/fish-weights.js';

const motionEnhancements = `<script>
(function installLeaderboardLoadingUX(){
  const rows=Array.from({length:7},()=>'<div class="lb-skeleton-row"><span class="lb-skeleton-bar rank"></span><span class="lb-skeleton-bar name"></span><span class="lb-skeleton-bar value"></span></div>').join('');
  const markup='<div class="lb-skeleton" aria-label="Loading leaderboard">'+rows+'</div>';
  const install=()=>['lb-catches','lb-rares'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    const apply=()=>{const text=(el.textContent||'').trim().toLowerCase();if((text.includes('loading')||text.includes('re-reading'))&&!el.querySelector('.lb-skeleton'))el.innerHTML=markup;};
    apply();new MutationObserver(apply).observe(el,{childList:true,subtree:true,characterData:true});
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
</script>`;
const liveWeightData = `<script>window.__FISH_LIVE_WEIGHTS__=${JSON.stringify(TIERS.map((tier) => ({id:tier.id,name:tier.name,items:fishWeightTable(tier)})))};</script>`;
const liveWeightScript = '<script src="/scripts/live-weight-tooltip.js?v=4"></script>';
const gameModeStyle = '<link rel="stylesheet" href="/styles/game-mode.css?v=2"><link rel="stylesheet" href="/styles/vibe-polish.css?v=1">';
const gameModeManifest = '<link rel="manifest" href="/game.webmanifest"><link rel="icon" type="image/png" sizes="192x192" href="/icons/game-192.png">';
const gameModeScript = '<script src="/scripts/game-mode.js?v=2"></script>';
const fishdexFilterScript = '<script src="/scripts/fishdex-caught-filter.js?v=2"></script>';

/* Move only the existing streamer selector into the existing profile-banner
   bottom row. The streamer/status logic itself is untouched. */
const streamerPlacementStyle = `<style id="streamer-placement-fix">
.profile-hero-top > [data-profile-streamer-moved="1"]{
  grid-column:1!important;
  grid-row:2!important;
  justify-self:end!important;
  align-self:end!important;
  width:min(470px,100%)!important;
  max-width:100%!important;
  margin:0 0 2px!important;
  z-index:4!important;
}
@media(max-width:680px){
  .profile-hero-top > [data-profile-streamer-moved="1"]{
    grid-column:auto!important;
    grid-row:auto!important;
    order:3!important;
    width:100%!important;
    margin:0!important;
  }
}
</style>`;

const streamerPlacementScript = '';

export default async function handler(req,res){
  const originalSend=res.send.bind(res);
  res.send=(body)=>{
    if(typeof body==='string'){
      if(body.includes('</head>'))body=body.replace('</head>','<link rel="stylesheet" href="/styles/profile-banner.css?v=12">'+streamerPlacementStyle+gameModeStyle+gameModeManifest+'</head>');
      if(body.includes('</body>')){
        body=body.replace('</body>',motionEnhancements+liveWeightData+liveWeightScript+streamerPlacementScript+gameModeScript+fishdexFilterScript+'</body>');
      }
    }
    return originalSend(body);
  };
  return baseHandler(req,res);
}

# Twitch chat commands (viewer reference)

The desktop Extension is optional. Viewers can use these commands directly in the broadcaster's Twitch chat from desktop or mobile. Command response visibility is configured by the streamer in **Control Centre → Game settings → Fishing and chat → Viewer management command replies**. **Private Whisper** is the default; **Public Twitch chat** posts command responses in the channel. The bot never accepts a target username in these commands; a viewer can only operate on their own account.

## Full command syntax

| Command syntax | What it does | Notes / examples |
|---|---|---|
| `!buy` | Lists purchasable Treasury perks and current prices in the selected reply mode. | Use the perk ID, not the display label. |
| `!buy <perk-id>` | Buys a one-time shop perk with the viewer's Treasury inventory. | Example: `!buy cooldown`. Already-owned perks cannot be purchased twice. `treasuryOnly` is an unlock milestone, not a paid item. |
| `!buy rarityBoost <rarity>` | Buys the 15-minute Rarity Boost for the selected tier. | Allowed tiers: `godly`, `legendary`, `epic`, `rare`, `uncommon`. Example: `!buy rarityBoost legendary`. |
| `!perks` | Shows the viewer's active perks and the shop IDs/prices in the selected reply mode. | This is also the quick way to look up shop IDs. |
| `!perks enable <perk-id>` | Enables an owned toggleable perk. | Example: `!perks enable luck125`. Ownership and unlock rules still apply. |
| `!perks disable <perk-id>` | Disables an owned toggleable perk. | Example: `!perks disable treasuryOnly`. Temporary effects may be paused according to their game rules. |
| `!autofish start` | Starts the viewer's Auto-Fish using the current/default area. | Requires the viewer to have an Auto-Fish license/unlock and available capacity under the game settings. |
| `!autofish start <area-id>` | Starts Auto-Fish targeting the viewer's unlocked area. | Area IDs: `forest`, `shieldlake`, `reef`, `frozen`, `emberpool`, `whalebone`. Example: `!autofish start reef`. |
| `!autofish stop` | Stops the viewer's own Auto-Fish. | It does not affect other viewers. |
| `!areas` or `!areas list` | Lists fishing areas, owned levels, selected area, unlock prices and Treasury balance. | A `*` marks the selected area. Prices reflect the streamer's saved area pricing. |
| `!areas buy <area-id>` | Unlocks an area using the viewer's Treasury inventory. | Example: `!areas buy forest`. The area must be enabled by the streamer. |
| `!areas select <area-id>` | Selects an area the viewer already owns. | Example: `!areas select forest`. The selected area affects compatible fishing/Auto-Fish behavior. |
| `!areas unselect` | Clears the viewer's selected area and returns them to normal waters. | Does not remove area ownership. |
| `!treasury` | Shows Treasury currently available, Treasury caught/earned, and net spent/used. | Historic spend may be an estimate when the older database did not record all purchases. Purchases made through these chat commands are tracked. |
| `!inventory` or `!inv` | Shows the viewer's inventory summary. | `!inventory list` or `!inventory page <number>` shows a compact page. |
| `!stats` | Shows the viewer's catch, Fishdex and Auto-Fish summary. | Only the calling viewer's data is returned. |
| `!fishdex` or `!dex` | Shows the viewer's Fishdex discovery count. | Only the calling viewer's data is returned. |
| `!pond` | Shows the viewer's Personal Pond status. | Only the calling viewer's data is returned. |
| `!leaderboard` or `!top` | Shows the top three catch counts. | This is an aggregate public game statistic; the response follows the selected reply mode. |
| `!help` | Returns a compact command summary in the selected reply mode. | Use the table on this page for exact syntax. |

### Shop perk IDs

The shop currently includes these IDs; `!buy` and `!perks` show the current configured Treasury price:

| Perk ID | Display name / behavior |
|---|---|
| `luck125` | Permanent 1.25x Luck |
| `cooldown` | 15% Cooldown Reduction |
| `treasuryLuck` | 1.5x Treasury Luck |
| `rarityBoost` | 2x rarity luck for 15 minutes; also requires the target rarity on `!buy` |
| `treasuryOnly` | Treasury Only Mode unlock, earned after 25 manual catches; enable after unlocking |
| `fishermansFortune` | Fisherman's Fortune |

`!perks enable|disable <perk-id>` also accepts supported legacy perks (`perm`, `temp`, `vip`, `event`, `shield`) and owned Personal Pond Treasury perks, such as `speciesHunter`, `baitSaver`, `collectorInstinct`, `stillWaters`, `deepCurrent`, `biggerHaul`, `fishyFortune` and `treasuryWaters`. A toggle does not grant ownership or bypass level/unlock requirements.

## Privacy, safety and rate limits

- Every management command is scoped to the sender's Twitch login and validated before a database mutation.
- The handler enforces a 2.5-second minimum gap between commands from the same viewer and a 10-second cooldown per command/viewer. Input is limited to 250 characters, with strict command argument allowlists.
- Command responses use the selected mode: private Twitch Whisper (default) or public Twitch chat. In public mode, all channel viewers can see each response; replies also pass through the shared rate-limited chat queue.
- Whisper mode needs the sending account's `user:manage:whispers` scope, a verified phone number, and recipient privacy settings that permit whispers. Twitch limits unique whisper recipients to 40 per day. See [`OBS-SETUP.md`](OBS-SETUP.md) for setup notes.
- `!fish` remains the normal public fishing command and is not converted to a private management reply.

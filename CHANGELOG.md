# Changelog

All notable changes to OpenVibe.Games are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Touch play's HUD was buried under the controls.** On a phone, the stick (bottom left) and the button grid (bottom
  right) covered the first-steps panel, and the HP, food, water and stamina bars sat on the hotbar. While the touch
  controls show:
  - the hotbar sits above the buttons, in smaller slots;
  - the bars sit above the stick;
  - the waypoint sits under the OpenVibe button;
  - the first-steps panel sits at the top right and shows only the step in progress;
  - the debug status line hides.
- **An empty pile kept saying "E — gather".** When a node had nothing left (the gate piles empty fast when several new
  scrappers arrive together), its prompt still offered to gather and E did nothing. It now says so, for example
  "Loose Stones — picked clean, back within 2 mins" or "Oak Tree — felled, grows back within … mins". A production
  play-test found it: a new guest walked to the north gate, and the branch pile had been emptied a minute earlier.
- **"City Warden — LMB attack".** Looking at a friendly warden or townsperson now shows just their name, so the prompt
  no longer invites you to hit them; a swing still lands. Wildlife says "LMB hunt", and Rustjaw thugs keep "⚠ — LMB
  attack".
- **Scrap City drew every static on its own.** It is several hundred static meshes (walls, wall plates, buildings,
  roofs, doors, stalls), and each textured one had a material of its own because its texture's scale follows its size.
  That came to 165 draw calls in view and 298 shadow casters, with 525 materials.
  - Statics are now merged once built (`render/staticBatches.ts`). Each static's texture tiling is baked into its UVs
    and its tint into its vertex colours, so everything with one texture shares one material, per 32 m square.
  - Lamps, the fountain, statics the water reflects, painted surfaces, per-face styles and glb models stay as they
    were.
  - A live map save unbatches, rebuilds what changed and batches again.
  - Lamp lights switch off by day, not just dim: at intensity 0 a lamp still cost every pixel it was included on. A
    batch is under the lamps' size limit (60 m; the terrain is 210 m).
  - In town: statics went from 165 draw calls to 44 and shadow casters from 439 to 178. The frame came to about 230
    draw calls (720 this evening), and a test browser ran at 38–44 fps instead of 8–13.
- **Far avatars floated, twisted.** The merged copy that stands in for an avatar past 18 m baked each part's world
  position, but a Babylon clone keeps its source's parent, so the joint chain applied a second time: far NPCs hung
  0.4 m up, out of shape. Each copy now drops its parent before baking, and a test checks that the copy stands on its
  feet at a person's height.
- **NPCs cost 150 draw calls in town.** Each avatar is about 14 meshes, so eleven townsfolk and wardens in view drew
  150 times a frame. Past 18 m an avatar, NPC or remote player, now draws as one merged copy of itself in its rest
  pose and skips the animation work. It switches back to the full rig inside 16 m. In town, NPC draws went from 150
  to 4.
- **Shadows halved the frame rate in town.** The shadow pass drew every caster in Scrap City again each frame (about
  390 more draw calls, ~720 a frame), and a test browser dropped from ~50 to ~10 fps. The shadow map is now redrawn
  every third frame, and at once whenever the shadow box moves, so no shadow jumps. That gives ~490 draw calls and
  about twice the frame rate in the same browser.
- **Lamps blacked out the world.** A material uses its first 8 lights, and the town's lamp lights (off by day) were
  created before the sun and sky. A map with a dozen lamps rendered every surface black. The sun and sky now have the
  higher render priority. Each lamp lights only the geometry in its range, and its light goes with its post, so a live
  map save no longer leaks lights.
- **Terrain paint never showed.** The layered surface sampled the paint mask at the base texture's tiled UV. On any
  terrain (base tiling half its extent), the mask read its clamped edge, so one layer covered the whole terrain. The
  mask now spans the surface once, and each layer tiles by its own count.
- **Nights lit from under the ground.** After sunset the sun's light kept the set sun's direction, pointing up out of
  the ground, so the ground got only sky light and nights were brown-black. The light is now the moon's, shining down
  from the moon, a little stronger than the old night light.
- **The first-person hand.** The right fist stood upright in front of a held tool, a flat skin-coloured block in the
  corner of the screen, and the gun's grip sat below the screen's edge. Now the fist closes on each tool's grip, the
  gun's grip or low on an axe or pickaxe handle (the head leaning away), and the forearm runs out of the lower-right
  corner. The arm is lit a little from within, like the tool, so it reads at night.
- **The status line under the OpenVibe button.** In the world, the tick, fps and entity line sat under the folded
  Frame's button in the same corner. It now sits below it.

### Added

- **A waypoint for the first steps.** An arrow and a distance at the top of the screen point toward the current
  step's target: "Oak Tree · 30 m". The target is the nearest node in sight that has something left (a starter pile,
  preferring whichever gives what you still lack; an oak; a stone deposit; a scrap pile), else a landmark. The haul step
  points at the recovery bird's announced landing. "The forest is west of town" was all a new scrapper had to find a
  forest over 100 m away.
  - Landmarks are map zones with the wilds' own rules, so they change no gameplay: The Forest, The Quarry and The
    Scrapyard on Scrap Island. They can be moved in the editor.
- **The town's props look like things.** Merchant stalls have a counter, posts, a striped awning in the stall's colour
  and goods on top. Crates have edge boards, barrels have hoops and a bung, and the storage box has a lid and a latch.
  The workbench has legs, a shelf, a vise and a saw, the still has a dome and a pipe, planters grow, and the campfire
  is logs in a ring of stones under an unlit flame. Every prop was its collision shape in one flat colour (the plaza's
  stalls were purple boxes). Each look is one vertex-coloured mesh, so a prop is still one draw call.
- **NPCs look like people.** Wardens, townsfolk and Rustjaw thugs wear the players' own low-poly avatar, so they
  walk, turn and flinch like players. Each is dressed by its archetype (wardens in denim or slate, Rustjaw in rust
  with beards and buzz cuts, townsfolk in everyday colours) and varied by its id. Dust hares are small faceted hares.
  Every NPC was a tinted box with a box head.
- **NPCs in the map, and 26 on Scrap Island.** The v2 map document has `npcs` (an archetype and a ground position),
  and the editor's Entity tool places them: City warden, Townsfolk, Dust hare and Rustjaw thug. A map with NPCs
  replaces the content's seven spawns, which were laid out for the procedural world and stood Rustjaw thugs just
  outside Scrap City's wall. The server matches the NPCs to the map's spawns at boot and on every live save: a spawn
  placed, moved or deleted in the editor shows up at once, and an NPC no spawn claims goes, saved row and all. Scrap
  Island now has:
  - a warden at each gate and one by the spawn square;
  - six townsfolk on the avenues and the ring road;
  - nine hares at the farm and in the fields;
  - six Rustjaw thugs at the far end of the scrapyard, in the deep forest and on Rust Ridge, all beyond a leash's
    reach of a gate.

  Creator worlds still run no NPCs, and a creator map with NPC spawns says so.
- **Something flies off a hit.** Wood chips off a tree or branches, grit off a rock, sparks off scrap, leaves off a
  bush. Before, a swing changed nothing on screen until the server moved a count. Nothing flies toward the camera, and a
  point-blank hit throws smaller pieces. Two thin-instanced meshes draw every particle.
- **Sound.** Scraplandia had none. Every sound is synthesised in the browser, so there are no files to load:
  - footsteps on grass, stone and water;
  - a jump and a landing as hard as the fall;
  - a swing's whoosh;
  - the hit: a thunk on wood, a clack on stone, a ring on scrap, a thud on people;
  - a blip when something goes into the pack, and a chime on a level-up;
  - wind that gusts and rises in a storm, rain, birds by day and crickets at night.

  Under water everything is muffled. Settings has a volume slider (saved; 0 is off). Audio starts on the first click
  or key, as browsers require.
- **First steps.** A new scrapper gets a checklist in the corner:
  - gather branches and stones (piles just inside every city gate);
  - craft a Stone Axe;
  - chop an oak in the west forest;
  - mine at the quarry;
  - salvage the scrapyard;
  - extract a haul.

  Each step says where to go. Progress only moves forward and is kept in the browser, and the list can be closed.
- **Scrap Island, Scraplandia's world (2026-10-19).** Production ran on an empty map document, so a new player
  spawned over open water and drowned within seconds. `apps/server/src/maps/scrapIsland.ts` generates the island as an
  ordinary v2 map document, the file the editor saves, so staff keep editing it in `/editor`. It is deterministic.
  - **Scrap City**, walled and safe: the plaza and fountain, four market stalls, a crafting corner, avenues and a ring
    road, houses, tenements and shacks, lamps and four watchtowers.
  - **The wilds**: the scrapyard (container stacks, a crane, wrecks, scrap piles), the forest (about 200 oaks, berries
    and branches), the terraced quarry, Rust Ridge and its radio mast, the lake and jetty, the farm, the shipwreck
    beach, and ruins along the dirt roads.
  - The terrain is one 420 m heightfield painted grass, rock and sand.
  - Scraplandia's world id is now `scrap_island`: resources re-seed and characters move to the new spawn.
  - Write it with `scripts/writeScrapIsland.ts` (docs/games.md).

- **KTX2 surface textures (M6).** The built-in surface textures ship as KTX2 (Basis ETC1S with mipmaps), beside their
  JPEGs:
  - the GPU keeps them compressed, about a seventh of the memory of a decoded JPEG, which matters most on the low tier;
  - they decode in workers instead of on the main thread;
  - they are a quarter smaller (1.64 MB against 2.17 MB).

  Babylon's decoder is vendored same-origin in `/ktx2/` (`apps/client/scripts/vendorKtx2.sh`, following
  `@babylonjs/core`), so nothing loads from Babylon's CDN. `apps/client/scripts/encodeKtx2.sh` makes the files with
  basisu, flipped vertically, because Babylon does not flip compressed data the way it flips a JPEG. This was checked
  pixel by pixel in Chrome.

  The JPEG is used when WebAssembly or workers are missing, with `?ktx2=0`, with `openvibe.ktx2=off`, or when a KTX2
  fails to load. The server answers `.ktx2` as `image/ktx2`.

- **The casual line and Vibe Heroes (plan T22).** `packages/casual` is a kit for small phone-first games: data
  packs, a server-fought auto-battle, shards and fusing, levels and star-ups, gear, energy, an idle chest with
  offline earnings, daily and weekly quests, a login calendar, earned-only summons with published odds and a
  visible guarantee, and a gem store whose products list exactly what they give. Vibe Heroes (20 original
  heroes, 100 stages in 10 chapters) plays at `/play/vibe-heroes` as a guest, and a sign-in on the same browser
  takes the save into the account. Every currency or item change is a ledger line written in the same
  transaction as the state, under the client's idempotency key (migration 0007). The page loads under 30 KB of
  gzip JS, has its own share card, and keeps an ad link's `src`/`c` with the first visit.

- **Scraplandia "Haul" mode.** Recovery-bird extractions now score haul points:
  each secured valuable scores `count × valuable.points`. Valuable item definitions
  carry per-item points (`salvage_core` 20, `pepper_tonic` 30,
  `blueprint_scrap_pistol` 40, `blueprint_still` 60), defaulting to 10.
- **Scraplandia haul leaderboard.** `scraplandia` joins the leaderboard, ranked by
  summed haul points across all time and this week. The leaderboard page gains a
  Salvage Rush / Scraplandia haul switch.
- **Haul achievements.** Scraplandia gains First haul, Big haul (≥ 500 in one
  extraction) and Haul week (≥ 2,000 in one week), evaluated server-side after each
  recorded haul and shown in the in-game Achievements panel.

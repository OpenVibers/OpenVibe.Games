# Changelog

All notable changes to OpenVibe.Games are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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

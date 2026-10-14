# The casual line (plan T22)

Small browser games that an ad or a shared link opens straight into play on a phone, with nothing to install. Each
game is a content pack on one shared kit; the first is **Vibe Heroes**, an idle hero collector, at
`https://openvibe.games/play/vibe-heroes`.

## Pieces

| Where                                               | What                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/casual`                                   | The kit, engine-free: types, the content pack (`content/vibeHeroes.ts`), hero and enemy stats, the auto-battle, the rules as one reducer (`apply`), read-only views (energy, idle chest, featured heroes, odds, red dots), pack validation and digest. Server and page both import it. |
| `packages/persistence/migrations/0007_casual.sql`   | `casual_saves` (one save per game per account), `casual_ledger` (every currency and item change), `casual_actions` (idempotency records).                                                                                                                                              |
| `apps/server/src/casual`                            | The economy (`store.ts`), the JSON API (`routes.ts`), the page with its share card (`page.ts`).                                                                                                                                                                                        |
| `apps/client/casual.html`, `apps/client/src/casual` | The page: a phone-first DOM client with no 3D engine, under 30 KB of gzip JS.                                                                                                                                                                                                          |
| `apps/client/scripts/casualCard.ts`                 | Draws the 1200×630 share card into `public/casual/<game>/card.png`.                                                                                                                                                                                                                    |

## The server decides

The client sends intents; the server applies them inside one database transaction:

1. lock the player's save (`SELECT … FOR UPDATE`);
2. answer the stored result if this idempotency key was applied before (a retried request never pays twice);
3. run the kit's reducer on a copy of the state (a refusal changes nothing and answers 422 with its code);
4. write the new state, one ledger line per currency or item change, and the action record.

Battles are fought on the server with a fresh random seed and sent to the page as a log, which the page only plays
back. Stage rewards are fixed (no random drops), so energy refills never buy a chance.

## API

All under `/api/v1/casual/:game`. Identity is a Network session (`Authorization: Bearer`) or the browser's Games
guest token (`X-Guest-Token`), the same two the 3D games use. A signed-in request that still carries the guest
token takes over that guest's save when the account has none for that game.

| Method and path                                        | Answer                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST …/session` `{ src?, c? }`                        | `{ state, version, created, now, digest, player }`. The save is created on the first visit, and the ad link's `src` and `c` are kept then only.                                                                                                                                                            |
| `POST …/actions` `{ key, action }` + `X-Casual-Digest` | `{ state, version, result, now }`, `replay: true` for a repeated key; 409 `content_changed` when the page is older than the server's pack; 422 with the refusal's code.                                                                                                                                    |
| `GET …/leaderboard`                                    | The 50 furthest signed-in players (highest stage, then team power). Guests are never listed.                                                                                                                                                                                                               |
| `GET …/ledger?before=`                                 | The player's own ledger, newest first, 100 lines a page.                                                                                                                                                                                                                                                   |
| `GET …/numbers?days=30`                                | Staff only (`staff.games.manage`, by bearer or the site's session cookie): per ad source and campaign, the players who first opened the game in the window, how many fought, reached stage 5 and signed in, and next-day (D1) and seventh-day (D7) returns with how many players were old enough for each. |

Actions: `collect`, `battle {stage}`, `sweep {stage, times}`, `team {heroes}`, `level {hero, times}`,
`star {hero}`, `fuse {hero}`, `equip {hero, slot, gear}`, `summon {count: 1|10}`, `quest {quest}`, `login`,
`buy {product}`. Limits: `games.casual.session` 30/min per address, `games.casual.action` 120/min per player.

## Money and chance

- **Gems** are the premium currency. The wallet keeps gems earned in play (`gems`) apart from gems bought with money
  (`gemsPaid`); spending takes earned gems first. Gems never turn into Vibes and are never cashed out.
- **Nothing is sold for money yet.** Paid products (gem packs, a starter pack, a monthly card, a season pass) arrive
  with OpenVibe.Billing's checkout (plan T5, owner item O1); until then the store sells only for gems.
- **Summons use sigils**, which are earned in play (quests, logins, stages) and never sold. The odds of every hero
  are published in the game, a legendary is certain within 50 draws (the counter is shown), and ten at once always
  hold an epic or better. Paid random draws need the owner's decision (O37; ADR-055 proposes never paid chance).
- **Every product lists exactly what it gives**, including the weekly featured-shard bundles.

## Getting players

- The landing route is `/play/<game>?src=<source>&c=<campaign>`. The page sends `src` and `c` with the first visit
  and removes them from the address bar; they are kept on the save (first-party only) for campaign numbers.
- `…/numbers` is how a campaign is judged: landings, first battles, stage 5, sign-ins, D1 and D7. Returns are read
  from the ledger (any currency or item change that day).
- The page's share card (Open Graph and X `summary_large_image`) and its JSON-LD are filled in by the server.
- No third-party pixel runs. X's pixel waits for the owner's ads account and pixel id (O36) and a consent prompt.

## Adding a game

1. Write a `CasualPack` in `packages/casual/src/content/` and add it to `CASUAL_GAMES`.
2. `validatePack` must pass (the server refuses to start otherwise).
3. Run `node --import tsx apps/client/scripts/casualCard.ts <game>` for its share card.
4. Its page is `/play/<game>`; the sitemap, `/llms.txt` and the home page's JSON-LD list it automatically.

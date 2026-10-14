# Changelog

All notable changes to OpenVibe.Games are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

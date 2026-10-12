# Changelog

All notable changes to OpenVibe.Games are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

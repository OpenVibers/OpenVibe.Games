# OpenVibe.Games as an open game platform

The owner, 2026-10-27:
- "we want to make it more modular open to modder it's more like Gary's mod or the new s&box game or Roblox … make more of a game engine both 3D and 2D … monetizable using openvibe systems";
- instant-play browser games that "x.com or Twitter ads" link to, with cheap coin packs (the g123.jp model: no download, play on the site);
- "other people can make games just like the same way you can copy our game … make teams … asset store".

## What the market does (researched 2026-10-27)

**s&box (Facepunch, Garry's Mod's successor)**
- Launched on Steam on 2026-04-28. It runs on Source 2, has C# scripting, an editor and built-in multiplayer, and is MIT-licensed.
- Facepunch had paid creators $500k by launch. A March 2026 Valve agreement lets editor projects ship as royalty-free standalone Steam games.
- Reported since then: a move to free-to-play by the end of 2026, after paid access and cosmetics put players off; weak retention; open books showing a loss.
- Lessons: openness and creator pay draw creators, but a paid door and a thin player base hurt.

**Roblox**
- Creators earn through engagement payouts (Creator Rewards, from the play time of Premium and ad-eligible users) as well as their own sales. Robux cash out through DevEx.
- Payout rates rose 8.5% in September 2025. Third-party estimates put creator payouts at roughly 31% of revenue (unaudited).
- Lesson: pay creators for engagement, not only for sales, so free games are worth building.

**Poki and CrazyGames (instant web play)**
- HTML5 games, curated, ad-funded.
- Reported splits: Poki 100% to the developer for players they bring and 50/50 for players Poki brings. CrazyGames is cited at 60% of ad revenue and 70% of purchases (jam terms).
- Poki asks for a first download under about 8 MB.
- Lesson: a small first load and no install are the price of entry.

**G123 (CTW, Japan)**
- HTML5 anime games with no download, no install and no required sign-up. It reports over 500M users.
- It is known for heavy social-media ads, and a UK ASA investigation in 2025 found some unsuitable. The Nasdaq stock is down about half since its IPO.
- Lesson: the funnel works, but its ads damage the brand. Our rules already forbid what drew the complaints: nothing sexual with minor-looking characters, original characters only.

Sources:
- [GamingOnLinux, s&box launch](https://www.gamingonlinux.com/2026/04/facepunch-launches-s-box-the-highly-anticipated-successor-to-garrys-mod/page=1/)
- [games.gg, s&box creator payouts](https://games.gg/nl/news/sbox-lanceert-op-steam-met-duurzame-uitbetalingen-aan-makers-en-kritiek-op-epic/)
- [VGTimes, s&box going free](https://vgtimes.ru/gaming-news/171063-sbox-stanet-besplatnoy-naslednica-garrys-mod-otkazyvaetsya-ot-platnogo-vhoda.html)
- [Nasdaq, Roblox payouts](https://www.nasdaq.com/articles/roblox-raises-creator-payouts-will-margins-face-pressure-2026)
- [Cinevva, publishing on Poki](https://app.cinevva.com/guides/publish-game-poki)
- [Cinevva, web game monetization](https://app.cinevva.com/guides/web-game-monetization)
- [Wikipedia, CTW Inc.](https://en.wikipedia.org/wiki/CTW_Inc.)

## Where Games stands

Already here:
- **Content packs and mods:** content packs (`games-content@2`, declarative mods with per-capability grants) and server script mods (`games-quickjs@1`, with capabilities and CPU, memory and stack budgets); see `mods.md`.
- **Creator worlds:**
  - an editor, publishing, its own pages, Search and Quest events;
  - **remix** (copy a world into your own, credited);
  - characters that belong to the game (no platform slot cap, since 2026-10-27).
- **The casual kit (`casual.md`):** small DOM games with no Babylon and about 26 KB gzip, guest play from a link, campaign numbers, and earned-only summons.

## The plan, in order

1. **Characters belong to the game.** Done (Games#158): no "3 slots" door, a 24 technical ceiling. Next, a game's pack may declare its own character rule, read by the shell.
2. **Remix.** Done: copy, credit, count.
3. **Worlds with scripts.** The Garry's Mod moment.
   - A creator world may carry `games-quickjs@1` mods, with the same capability grants and budgets as packs, sandboxed to that world.
   - Its owner can edit them from the editor.
   - Moderation: staff can switch a world's scripts off.
4. **Teams.** A world gets editors besides its owner. The collaboration socket (`/editor-ws`, staff-only today) opens to a world's team.
5. **The asset store.** Creators publish models, materials, sounds and scripts for others to use and remix, free first.
   - Uploaded models and textures wait on the Pics safety pipeline, as the editor's limits already note.
   - Paid assets come later, priced in Vibes through Billing, with items in Inventory (ADR-054). The owner sets the prices.
6. **2D.** The casual kit is the 2D path. Next, a 2D world type made from the same editor and pack format, so a 2D game is a world too.
7. **The instant-play funnel.** `/play/<game>` already opens with no download and as a guest. To add:
   - campaign landing links with attribution (plan T22);
   - a first load kept under about 8 MB for 3D and the casual budget for 2D;
   - an X ads account and pixel, once the owner sets them up (O36).
8. **Creators get paid.** Engagement-based payouts in Vibes, in the spirit of Roblox Creator Rewards: play time in a creator's published worlds, from the money Billing actually takes in. This needs the owner's decision on the share and the rules.

## The owner's decisions

- **Paid chance (O37):** no paid random draws until decided (ADR-055).
- **Asset and pack prices:** the owner types the prices.
- **Creator payouts:** the share, the threshold and the eligibility.
- **Ads (O36):** the account, the budget and the pixel.

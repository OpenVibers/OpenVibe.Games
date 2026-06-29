import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { MemoryOpenVibeRepository } from "./repository-memory.js";
import { SessionInput } from "./sessions.js";

const steamId = "76561198000000000";
const serverSecret = "dev-secret";

async function testApp() {
  const app = await createApp({
    repository: new MemoryOpenVibeRepository(),
    devAuthEnabled: true,
  });
  await app.ready();
  return app;
}

describe("OpenVibe API vertical slice", () => {
  it("authenticates a dev player and returns profile/inventory/shop", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev",
      payload: { steamId, displayName: "Mapper" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.player.displayName).toBe("Mapper");
    expect(body.player.currencyBalance).toBe(250);
    expect(body.inventory.map((item: { itemId: string }) => item.itemId)).toContain("model_rebel");

    await app.close();
  });

  it("writes auth sessions to the configured session store", async () => {
    const sessions: SessionInput[] = [];
    const app = await createApp({
      repository: new MemoryOpenVibeRepository(),
      devAuthEnabled: true,
      sessionStore: {
        async createSession(input) {
          sessions.push(input);
        },
      },
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev",
      payload: { steamId, displayName: "Session Tester" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessionToken).toMatch(/^dev\.76561198000000000\./);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      steamId,
      provider: "dev",
      ttlSeconds: 86400,
    });

    await app.close();
  });

  it("keeps Steam auth disabled until Steam credentials are configured", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/steam",
      payload: {
        ticket: "0123456789abcdef",
        identity: "openvibe.games",
      },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().error).toBe("steam_auth_not_configured");

    await app.close();
  });

  it("returns a CDN asset manifest for shop-backed cosmetics", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "GET",
      url: "/v1/assets/manifest",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.cdnBaseUrl).toBe("https://openvibe.games/cdn");
    expect(body.assets.some((asset: { itemId: string; url: string }) =>
      asset.itemId === "trail_blue" && asset.url.includes("https://openvibe.games/cdn/"),
    )).toBe(true);

    await app.close();
  });

  it("registers servers and reserves a one-use travel token", async () => {
    const app = await testApp();

    await app.inject({
      method: "POST",
      url: "/v1/auth/dev",
      payload: { steamId, displayName: "Portal Tester" },
    });

    await app.inject({
      method: "POST",
      url: "/v1/servers/register",
      payload: {
        serverId: "local-prophunt-27016",
        serverSecret,
        mode: "prophunt",
        mapName: "ph_openvibe_dev",
        publicHost: "127.0.0.1",
        port: 27016,
        maxPlayers: 24,
      },
    });

    const travel = await app.inject({
      method: "POST",
      url: "/v1/travel/request",
      payload: { steamId, mode: "prophunt" },
    });

    expect(travel.statusCode).toBe(200);
    const reservation = travel.json();
    expect(reservation.connect).toBe("127.0.0.1:27016");

    const firstValidation = await app.inject({
      method: "POST",
      url: "/v1/travel/validate",
      payload: {
        token: reservation.joinToken,
        steamId,
        serverId: "local-prophunt-27016",
      },
    });
    expect(firstValidation.json().valid).toBe(true);

    const secondValidation = await app.inject({
      method: "POST",
      url: "/v1/travel/validate",
      payload: {
        token: reservation.joinToken,
        steamId,
        serverId: "local-prophunt-27016",
      },
    });
    expect(secondValidation.json().valid).toBe(false);

    await app.close();
  });

  it("keeps purchases and match rewards backend-authoritative and idempotent", async () => {
    const app = await testApp();

    await app.inject({
      method: "POST",
      url: "/v1/auth/dev",
      payload: { steamId, displayName: "Economy Tester" },
    });

    await app.inject({
      method: "POST",
      url: "/v1/servers/register",
      payload: {
        serverId: "local-deathrun-27017",
        serverSecret,
        mode: "deathrun",
        mapName: "dr_openvibe_dev",
        publicHost: "127.0.0.1",
        port: 27017,
        maxPlayers: 24,
      },
    });

    const purchase = await app.inject({
      method: "POST",
      url: "/v1/shop/buy",
      payload: { steamId, itemId: "trail_blue" },
    });
    expect(purchase.statusCode).toBe(200);
    expect(purchase.json().player.currencyBalance).toBe(150);

    const equip = await app.inject({
      method: "POST",
      url: "/v1/equip",
      payload: { steamId, itemId: "trail_blue" },
    });
    expect(equip.json().player.equippedTrailId).toBe("trail_blue");

    const rewardPayload = {
      matchId: "deathrun-round-1",
      serverId: "local-deathrun-27017",
      serverSecret,
      steamId,
      mode: "deathrun",
      rewardCurrency: 75,
      rewardXp: 120,
      stats: { finished: true },
    };

    const firstReward = await app.inject({
      method: "POST",
      url: "/v1/matches/end",
      payload: rewardPayload,
    });
    expect(firstReward.json().player.currencyBalance).toBe(225);
    expect(firstReward.json().player.xp).toBe(120);

    const duplicateReward = await app.inject({
      method: "POST",
      url: "/v1/matches/end",
      payload: rewardPayload,
    });
    expect(duplicateReward.json().player.currencyBalance).toBe(225);
    expect(duplicateReward.json().player.xp).toBe(120);

    await app.close();
  });

  it("returns a leaderboard sorted by xp descending", async () => {
    const app = await testApp();

    // Create two players with different XP via match rewards
    await app.inject({ method: "POST", url: "/v1/auth/dev",
      payload: { steamId: "76561198000000001", displayName: "Player One" } });
    await app.inject({ method: "POST", url: "/v1/auth/dev",
      payload: { steamId: "76561198000000002", displayName: "Player Two" } });

    await app.inject({ method: "POST", url: "/v1/servers/register",
      payload: { serverId: "lb-hub-27015", serverSecret, mode: "hub",
        mapName: "ov_hub", publicHost: "127.0.0.1", port: 27015, maxPlayers: 48 } });

    await app.inject({ method: "POST", url: "/v1/matches/end",
      payload: { matchId: "lb-1", serverId: "lb-hub-27015", serverSecret,
        steamId: "76561198000000001", mode: "hub", rewardCurrency: 50, rewardXp: 500 } });

    await app.inject({ method: "POST", url: "/v1/matches/end",
      payload: { matchId: "lb-2", serverId: "lb-hub-27015", serverSecret,
        steamId: "76561198000000002", mode: "hub", rewardCurrency: 20, rewardXp: 200 } });

    const res = await app.inject({ method: "GET", url: "/v1/leaderboard?limit=5" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.leaderboard).toHaveLength(2);
    expect(body.leaderboard[0].xp).toBeGreaterThan(body.leaderboard[1].xp);
    expect(body.leaderboard[0].rank).toBe(1);
    expect(body.leaderboard[1].rank).toBe(2);

    await app.close();
  });

  it("admin can upsert a shop item with correct secret", async () => {
    const adminSecret = "test-admin-secret";
    const repo = new MemoryOpenVibeRepository();
    const app = await createApp({ repository: repo, devAuthEnabled: true, adminSecret });
    await app.ready();

    const newItem = {
      itemId: "trail_purple",
      itemType: "trail",
      displayName: "Purple Trail",
      description: "A vivid purple trail.",
      assetPath: "particles/openvibe/trail_purple.pcf",
      price: 200,
      enabled: true,
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/shop/items",
      headers: { "x-admin-secret": adminSecret },
      payload: newItem,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().itemId).toBe("trail_purple");

    const shopRes = await app.inject({ method: "GET", url: "/v1/shop" });
    const items = shopRes.json().items as { itemId: string }[];
    expect(items.some((i) => i.itemId === "trail_purple")).toBe(true);

    await app.close();
  });

  it("admin endpoint rejects wrong secret with 403", async () => {
    const app = await createApp({
      repository: new MemoryOpenVibeRepository(),
      devAuthEnabled: true,
      adminSecret: "correct-secret",
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/shop/items",
      headers: { "x-admin-secret": "wrong-secret" },
      payload: { itemId: "x", itemType: "trail", displayName: "X",
        description: "", assetPath: "p", price: 0, enabled: true },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("supports party invites and capacity-aware party travel", async () => {
    const app = await testApp();
    const friendSteamId = "76561198000000003";

    await app.inject({ method: "POST", url: "/v1/auth/dev",
      payload: { steamId, displayName: "Party Leader" } });
    await app.inject({ method: "POST", url: "/v1/auth/dev",
      payload: { steamId: friendSteamId, displayName: "Party Friend" } });

    await app.inject({ method: "POST", url: "/v1/servers/register",
      payload: { serverId: "party-prophunt-1", serverSecret, mode: "prophunt",
        mapName: "ph_openvibe_dev", publicHost: "127.0.0.1", port: 27016, maxPlayers: 1 } });
    await app.inject({ method: "POST", url: "/v1/servers/register",
      payload: { serverId: "party-prophunt-2", serverSecret, mode: "prophunt",
        mapName: "ph_openvibe_dev", publicHost: "127.0.0.1", port: 27026, maxPlayers: 4 } });

    const partyRes = await app.inject({
      method: "POST",
      url: "/v1/parties",
      payload: { leaderSteamId: steamId },
    });
    expect(partyRes.statusCode).toBe(200);
    const party = partyRes.json();

    const inviteRes = await app.inject({
      method: "POST",
      url: "/v1/parties/invite",
      payload: { partyId: party.partyId, invitedBySteamId: steamId, invitedSteamId: friendSteamId },
    });
    expect(inviteRes.statusCode).toBe(200);

    const acceptRes = await app.inject({
      method: "POST",
      url: "/v1/parties/invite/accept",
      payload: { inviteId: inviteRes.json().inviteId, steamId: friendSteamId },
    });
    expect(acceptRes.json().members).toHaveLength(2);

    const travelRes = await app.inject({
      method: "POST",
      url: "/v1/parties/travel",
      payload: { partyId: party.partyId, leaderSteamId: steamId, mode: "prophunt" },
    });
    expect(travelRes.statusCode).toBe(200);
    expect(travelRes.json().serverId).toBe("party-prophunt-2");
    expect(travelRes.json().reservations).toHaveLength(2);

    await app.close();
  });

  it("records and lists admin audit events", async () => {
    const adminSecret = "test-admin-secret";
    const app = await createApp({
      repository: new MemoryOpenVibeRepository(),
      devAuthEnabled: true,
      adminSecret,
    });
    await app.ready();

    const event = await app.inject({
      method: "POST",
      url: "/v1/admin/audit/events",
      headers: { "x-admin-secret": adminSecret },
      payload: {
        actorSteamId: steamId,
        action: "moderation.note",
        targetSteamId: "76561198000000004",
        reason: "Testing moderation audit trail.",
      },
    });
    expect(event.statusCode).toBe(200);
    expect(event.json().action).toBe("moderation.note");

    const list = await app.inject({
      method: "GET",
      url: "/v1/admin/audit/events?limit=10",
      headers: { "x-admin-secret": adminSecret },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().events).toHaveLength(1);

    await app.close();
  });
});

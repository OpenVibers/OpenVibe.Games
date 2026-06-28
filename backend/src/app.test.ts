import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { MemoryOpenVibeRepository } from "./repository-memory.js";

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
});

const apiUrl = process.argv[2] ?? process.env.OPENVIBE_API_URL ?? "http://127.0.0.1:3000";
const steamId = process.env.OPENVIBE_DEV_STEAM_ID ?? "76561198000000000";
const serverSecret = process.env.OPENVIBE_DEFAULT_SERVER_SECRET ?? "dev-secret";

async function post(path, body) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function get(path) {
  const response = await fetch(`${apiUrl}${path}`);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

const health = await get("/health");
console.log(`[smoke] health ${health.ok}`);

const profile = await post("/v1/auth/dev", {
  steamId,
  displayName: "OpenVibe Smoke",
});
console.log(`[smoke] player ${profile.player.steamId} coins=${profile.player.currencyBalance}`);

const server = await post("/v1/servers/register", {
  serverId: "local-prophunt-27016",
  serverSecret,
  mode: "prophunt",
  mapName: "ph_openvibe_dev",
  publicHost: "127.0.0.2",
  port: 27016,
  maxPlayers: 24,
});
console.log(`[smoke] server ${server.serverId}`);

const travel = await post("/v1/travel/request", {
  steamId,
  mode: "prophunt",
});
console.log(`[smoke] travel ${travel.connect}`);

const validation = await post("/v1/travel/validate", {
  token: travel.joinToken,
  steamId,
  serverId: "local-prophunt-27016",
});
if (!validation.valid) throw new Error("expected join token to validate");
console.log("[smoke] token consumed");

const reward = await post("/v1/matches/end", {
  matchId: `smoke-${Date.now()}`,
  serverId: "local-prophunt-27016",
  serverSecret,
  steamId,
  mode: "prophunt",
  rewardCurrency: 25,
  rewardXp: 50,
  stats: { smoke: true },
});
console.log(`[smoke] reward coins=${reward.player.currencyBalance} xp=${reward.player.xp}`);

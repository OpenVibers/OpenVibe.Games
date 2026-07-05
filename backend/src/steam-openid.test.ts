import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, AppOptions } from "./app.js";
import { MemoryOpenVibeRepository } from "./repository-memory.js";
import { SteamOpenIdFetch } from "./steam-openid.js";

const steamId = "76561198000000001";
const claimedId = `https://steamcommunity.com/openid/id/${steamId}`;

async function testApp(overrides: Partial<AppOptions> = {}) {
  const app = await createApp({
    repository: new MemoryOpenVibeRepository(),
    devAuthEnabled: true,
    ...overrides,
  });
  await app.ready();
  return app;
}

function openIdResponse(body: string, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function returnUrl(returnPath: string, overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    return: returnPath,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": "http://127.0.0.1:3000/v1/auth/steam/openid/return?return=" + encodeURIComponent(returnPath),
    "openid.response_nonce": "2026-07-04T00:00:00Znonce",
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "fakesig=",
    ...overrides,
  });
  return `/v1/auth/steam/openid/return?${params.toString()}`;
}

describe("Steam OpenID browser sign-in", () => {
  afterEach(() => {
    delete process.env.OPENVIBE_PUBLIC_BASE;
    delete process.env.STEAM_WEB_API_KEY;
    vi.restoreAllMocks();
  });

  it("redirects /start to Steam with identifier_select and a derived base URL", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/steam/openid/start?return=%2Fclient%2F",
      headers: { host: "play.openvibe.games" },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin).toBe("https://steamcommunity.com");
    expect(location.pathname).toBe("/openid/login");
    expect(location.searchParams.get("openid.ns")).toBe("http://specs.openid.net/auth/2.0");
    expect(location.searchParams.get("openid.mode")).toBe("checkid_setup");
    expect(location.searchParams.get("openid.claimed_id")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
    expect(location.searchParams.get("openid.identity")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
    expect(location.searchParams.get("openid.realm")).toBe("http://play.openvibe.games");
    expect(location.searchParams.get("openid.return_to")).toBe(
      "http://play.openvibe.games/v1/auth/steam/openid/return?return=%2Fclient%2F",
    );

    await app.close();
  });

  it("prefers OPENVIBE_PUBLIC_BASE over the request host", async () => {
    process.env.OPENVIBE_PUBLIC_BASE = "https://openvibe.games/";
    const app = await testApp();

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/steam/openid/start",
      headers: { host: "127.0.0.1:3000" },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get("openid.realm")).toBe("https://openvibe.games");
    expect(location.searchParams.get("openid.return_to")).toBe(
      "https://openvibe.games/v1/auth/steam/openid/return?return=%2Fclient%2F",
    );

    await app.close();
  });

  it("sanitizes absolute and protocol-relative return targets to /client/", async () => {
    const app = await testApp();

    for (const evil of ["https://evil.com", "//evil.com", "/\\evil.com", ""]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/auth/steam/openid/start?return=${encodeURIComponent(evil)}`,
        headers: { host: "127.0.0.1:3000" },
      });

      expect(response.statusCode).toBe(302);
      const location = new URL(response.headers.location as string);
      expect(location.searchParams.get("openid.return_to")).toBe(
        "http://127.0.0.1:3000/v1/auth/steam/openid/return?return=%2Fclient%2F",
      );
    }

    await app.close();
  });

  it("verifies the assertion, creates a working session, and redirects with #ovtoken", async () => {
    const fetchMock = vi.fn(async () => openIdResponse("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n"));
    const app = await testApp({ steamOpenIdFetch: fetchMock as unknown as SteamOpenIdFetch });

    const response = await app.inject({ method: "GET", url: returnUrl("/client/") });

    expect(response.statusCode).toBe(302);
    const location = response.headers.location as string;
    expect(location.startsWith("/client/#ovtoken=")).toBe(true);

    // The verification POST must go back to Steam with mode=check_authentication.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(verifyUrl).toBe("https://steamcommunity.com/openid/login");
    expect(verifyInit.method).toBe("POST");
    const verifyParams = new URLSearchParams(verifyInit.body);
    expect(verifyParams.get("openid.mode")).toBe("check_authentication");
    expect(verifyParams.get("openid.sig")).toBe("fakesig=");
    expect(verifyParams.get("openid.claimed_id")).toBe(claimedId);

    // The minted token must pass GET /v1/auth/session.
    const token = decodeURIComponent(location.slice("/client/#ovtoken=".length));
    const session = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ valid: true, provider: "steam", steamId });

    // Player was upserted with the fallback display name (no STEAM_WEB_API_KEY).
    const me = await app.inject({ method: "GET", url: `/v1/me?steamId=${steamId}` });
    expect(me.statusCode).toBe(200);
    expect(me.json().player.displayName).toBe(`Steam ${steamId.slice(-6)}`);

    await app.close();
  });

  it("sanitizes the return path on /return as well", async () => {
    const fetchMock = vi.fn(async () => openIdResponse("is_valid:true\n"));
    const app = await testApp({ steamOpenIdFetch: fetchMock as unknown as SteamOpenIdFetch });

    const response = await app.inject({ method: "GET", url: returnUrl("//evil.com") });

    expect(response.statusCode).toBe(302);
    expect((response.headers.location as string).startsWith("/client/#ovtoken=")).toBe(true);

    await app.close();
  });

  it("rejects the login when Steam says is_valid:false and issues no token", async () => {
    const fetchMock = vi.fn(async () => openIdResponse("ns:http://specs.openid.net/auth/2.0\nis_valid:false\n"));
    const app = await testApp({ steamOpenIdFetch: fetchMock as unknown as SteamOpenIdFetch });

    const response = await app.inject({ method: "GET", url: returnUrl("/client/") });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("steam_openid_verification_failed");
    expect(response.headers.location).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("ovtoken");

    await app.close();
  });

  it("rejects the login when the verification request errors", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const app = await testApp({ steamOpenIdFetch: fetchMock as unknown as SteamOpenIdFetch });

    const response = await app.inject({ method: "GET", url: returnUrl("/client/") });

    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it("returns 400 for a malformed claimed_id", async () => {
    const fetchMock = vi.fn(async () => openIdResponse("is_valid:true\n"));
    const app = await testApp({ steamOpenIdFetch: fetchMock as unknown as SteamOpenIdFetch });

    for (const bad of [
      "https://evil.com/openid/id/76561198000000001",
      "https://steamcommunity.com/openid/id/1234",
      "https://steamcommunity.com/openid/id/notanumber",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: returnUrl("/client/", { "openid.claimed_id": bad }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("steam_openid_bad_claimed_id");
    }

    // claimed_id missing entirely
    const params = new URLSearchParams({ return: "/client/", "openid.mode": "id_res" });
    const missing = await app.inject({
      method: "GET",
      url: `/v1/auth/steam/openid/return?${params.toString()}`,
    });
    expect(missing.statusCode).toBe(400);

    // No verification call should have been made for malformed assertions.
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("uses the Steam persona name when STEAM_WEB_API_KEY is set, and never fails login on persona errors", async () => {
    process.env.STEAM_WEB_API_KEY = "test-key";

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("GetPlayerSummaries")) {
        return openIdResponse(JSON.stringify({ response: { players: [{ personaname: "GordonF" }] } }));
      }
      return openIdResponse("is_valid:true\n");
    });
    const app = await testApp({ steamOpenIdFetch: fetchMock as unknown as SteamOpenIdFetch });

    const response = await app.inject({ method: "GET", url: returnUrl("/client/") });
    expect(response.statusCode).toBe(302);

    const me = await app.inject({ method: "GET", url: `/v1/me?steamId=${steamId}` });
    expect(me.json().player.displayName).toBe("GordonF");

    await app.close();

    // Persona lookup failure still signs the player in with the fallback name.
    const failingFetch = vi.fn(async (url: string) => {
      if (url.includes("GetPlayerSummaries")) throw new Error("steam api down");
      return openIdResponse("is_valid:true\n");
    });
    const app2 = await testApp({ steamOpenIdFetch: failingFetch as unknown as SteamOpenIdFetch });

    const response2 = await app2.inject({ method: "GET", url: returnUrl("/client/") });
    expect(response2.statusCode).toBe(302);
    expect((response2.headers.location as string).startsWith("/client/#ovtoken=")).toBe(true);

    const me2 = await app2.inject({ method: "GET", url: `/v1/me?steamId=${steamId}` });
    expect(me2.json().player.displayName).toBe(`Steam ${steamId.slice(-6)}`);

    await app2.close();
  });
});

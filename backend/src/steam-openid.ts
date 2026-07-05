import { FastifyInstance, FastifyRequest } from "fastify";
import { OpenVibeRepository } from "./domain.js";
import { createSessionToken, OpenVibeSessionStore } from "./sessions.js";

// Minimal fetch shape so tests can inject a mock without matching lib.dom types exactly.
export type SteamOpenIdFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface SteamOpenIdRouteOptions {
  repository: OpenVibeRepository;
  sessionStore?: OpenVibeSessionStore;
  steamOpenIdFetch?: SteamOpenIdFetch;
}

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const CLAIMED_ID_PATTERN = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const DEFAULT_RETURN_PATH = "/client/";

// Only accept same-origin, path-only return targets: must start with "/",
// must not be protocol-relative ("//host") or a backslash trick ("/\host").
export function sanitizeReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return DEFAULT_RETURN_PATH;
  if (!value.startsWith("/")) return DEFAULT_RETURN_PATH;
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_RETURN_PATH;
  return value;
}

function resolveBaseUrl(request: FastifyRequest): string {
  const envBase = process.env.OPENVIBE_PUBLIC_BASE;
  if (envBase) return envBase.replace(/\/+$/, "");
  const host = request.headers.host ?? "127.0.0.1:3000";
  return `http://${host}`;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export async function fetchPersonaName(
  fetchImpl: SteamOpenIdFetch,
  steamId: string,
  log: FastifyRequest["log"],
): Promise<string> {
  const fallback = `Steam ${steamId.slice(-6)}`;
  const apiKey = process.env.STEAM_WEB_API_KEY;
  if (!apiKey) return fallback;

  try {
    const url = new URL(
      "/ISteamUser/GetPlayerSummaries/v2/",
      process.env.STEAM_WEB_API_BASE ?? "https://api.steampowered.com",
    );
    url.searchParams.set("key", apiKey);
    url.searchParams.set("steamids", steamId);

    const response = await fetchImpl(url.toString());
    if (!response.ok) return fallback;

    const json = (await response.json()) as {
      response?: { players?: Array<{ personaname?: string }> };
    };
    const persona = json.response?.players?.[0]?.personaname;
    if (typeof persona === "string" && persona.trim().length > 0) {
      return persona.trim();
    }
  } catch (error) {
    log.warn({ err: error }, "steam persona lookup failed; using fallback display name");
  }
  return fallback;
}

export function registerSteamOpenIdRoutes(
  app: FastifyInstance,
  options: SteamOpenIdRouteOptions,
): void {
  // Step 1: send the browser to Steam's OpenID login page.
  app.get("/v1/auth/steam/openid/start", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const returnPath = sanitizeReturnPath(firstString(query["return"]));
    const base = resolveBaseUrl(request);

    const target = new URL(STEAM_OPENID_ENDPOINT);
    target.searchParams.set("openid.ns", OPENID_NS);
    target.searchParams.set("openid.mode", "checkid_setup");
    target.searchParams.set("openid.claimed_id", IDENTIFIER_SELECT);
    target.searchParams.set("openid.identity", IDENTIFIER_SELECT);
    target.searchParams.set(
      "openid.return_to",
      `${base}/v1/auth/steam/openid/return?return=${encodeURIComponent(returnPath)}`,
    );
    target.searchParams.set("openid.realm", base);

    return reply.redirect(target.toString(), 302);
  });

  // Step 2: Steam redirects back here; verify the assertion, mint a session,
  // and bounce to the client page with the token in the URL fragment.
  app.get("/v1/auth/steam/openid/return", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const returnPath = sanitizeReturnPath(firstString(query["return"]));
    const fetchImpl: SteamOpenIdFetch =
      options.steamOpenIdFetch ?? (fetch as unknown as SteamOpenIdFetch);

    const claimedId = firstString(query["openid.claimed_id"]);
    const claimedMatch = claimedId ? CLAIMED_ID_PATTERN.exec(claimedId) : null;
    if (!claimedMatch) {
      return reply.code(400).send({ error: "steam_openid_bad_claimed_id" });
    }
    const steamId = claimedMatch[1];

    // Re-POST every openid.* param back to Steam with mode=check_authentication.
    const verifyBody = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (!key.startsWith("openid.")) continue;
      const str = firstString(value);
      if (str !== undefined) verifyBody.set(key, str);
    }
    verifyBody.set("openid.mode", "check_authentication");

    let verified = false;
    try {
      const response = await fetchImpl(STEAM_OPENID_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: verifyBody.toString(),
      });
      if (response.ok) {
        const text = await response.text();
        verified = /is_valid\s*:\s*true/.test(text);
      } else {
        request.log.warn({ status: response.status }, "steam openid verification request failed");
      }
    } catch (error) {
      request.log.warn({ err: error }, "steam openid verification errored");
    }

    if (!verified) {
      return reply.code(401).send({ error: "steam_openid_verification_failed" });
    }

    // Persona lookup is best-effort: never fail the login because of it.
    const displayName = await fetchPersonaName(fetchImpl, steamId, request.log);

    await options.repository.upsertDevPlayer({ steamId, displayName });
    const sessionToken = await createSessionToken(options.sessionStore, "steam", steamId);

    return reply.redirect(`${returnPath}#ovtoken=${encodeURIComponent(sessionToken)}`, 302);
  });
}

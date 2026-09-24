/**
 * Games as a platform principal (ADR-003): every call Games makes to another
 * OpenVibe service — Events, Media, Network identity — carries a
 * client-credentials token of the `games` OAuth client, one cached token per
 * audience (`openvibe.events`, `openvibe.media`, `openvibe.network`). There
 * is no shared key anywhere: the Network grants each capability explicitly.
 *
 * The SSO calls made on a player's behalf (/api/auth/me, the code and FedCM
 * exchanges in httpServer.ts) keep using the player's own token and the
 * OAuth client authentication they need; they are not service calls.
 */
import { createServiceTokenClient } from 'openvibe-sdk/auth'
import { createClient, type FetchLike, type OpenVibeClient } from 'openvibe-sdk/core'
import type { PlatformConfig } from '../config.js'

export interface PlatformClient {
  client: OpenVibeClient
  clientId: string
  /** The `games` principal's tokens, for calls the SDK client has no method for (Events subscriptions). */
  tokens: { getToken(ctx?: { audience?: string; scope?: string }): Promise<string> }
}

/** Null when no client secret is configured: Games then makes no service calls. */
export function createPlatformClient(
  cfg: PlatformConfig,
  fetchImpl?: FetchLike,
): PlatformClient | null {
  if (!cfg.clientSecret) return null
  const tokens = createServiceTokenClient({
    tokenUrl: `${cfg.networkUrl}/oauth/token`,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  const baseUrls: Record<string, string> = { network: cfg.networkUrl }
  if (cfg.eventsUrl) baseUrls.events = cfg.eventsUrl
  if (cfg.mediaUrl) baseUrls.media = cfg.mediaUrl
  const client = createClient({
    network: cfg.networkUrl,
    baseUrls,
    tokenProvider: tokens,
    autoDiscover: false,
    // The outbox and the mirror queue do their own retrying with backoff.
    retries: 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  return { client, clientId: cfg.clientId, tokens }
}

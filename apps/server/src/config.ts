export interface ServerConfig {
  port: number
  host: string
  dbPath: string
  /** Directory of built client assets to serve, or null for API/WS only. */
  staticDir: string | null
  mapPath: string
  editorKey: string | null
  networkAuthUrl: string | null
  /** Bind fresh guest tokens to client IPs (off in tests: peers share an IP). */
  guestIpBinding: boolean
  /** openvibe.network OAuth client (SSO); null until the secret is configured. */
  oauth: {
    clientId: string
    clientSecret: string
    baseUrl: string
    selfUrl: string
    /** Public base of the play host (Host-routed game vhost). */
    playUrl: string
  } | null
  /**
   * Platform integration (roadmap Wave 12): Games calls OpenVibe services with
   * a client-credentials token of its own `games` principal. Everything here
   * is off until OV_OAUTH_CLIENT_SECRET (the same OAuth client as SSO) is set.
   */
  platform: PlatformConfig
  tickRate: number
  /** Send a snapshot every N ticks. */
  snapshotEvery: number
  /** Entities beyond this distance from a player are not replicated to them. */
  interestRadius: number
  maxPlayers: number
  persistFlushSeconds: number
  metricsLogSeconds: number
  /** Multiplier on world-event cadences (tests shrink it). */
  eventIntervalScale: number
}

export interface PlatformConfig {
  /** OAuth client id of the `games` principal (shared with SSO). */
  clientId: string
  /** Its client secret; null = no service calls at all. */
  clientSecret: string | null
  /** Network base for /oauth/token, identity and the JWKS (host-internal in production). */
  networkUrl: string
  /** OpenVibe.Events base; null = no durable events (the outbox is not even created). */
  eventsUrl: string | null
  /** OpenVibe.Media base; null = map assets stay local only. */
  mediaUrl: string | null
  /** Media namespace (tenant app id) Games writes objects into. */
  mediaNamespace: string
  /** At most one `games.world.saved` checkpoint event per this many minutes. */
  worldSavedEventMinutes: number
}

function trimSlash(v: string): string {
  return v.replace(/\/+$/, '')
}

export function loadPlatformConfig(env: NodeJS.ProcessEnv): PlatformConfig {
  const secret = env.OV_OAUTH_CLIENT_SECRET ?? null
  return {
    clientId: env.OV_OAUTH_CLIENT_ID ?? 'games',
    clientSecret: secret && secret.length > 0 ? secret : null,
    networkUrl: trimSlash(
      env.OV_NETWORK_INTERNAL_URL ?? env.OV_NETWORK_URL ?? 'https://openvibe.network',
    ),
    eventsUrl: env.EVENTS_URL && env.EVENTS_PUBLISH !== 'off' ? trimSlash(env.EVENTS_URL) : null,
    mediaUrl: env.MEDIA_URL && env.MEDIA_MIRROR !== 'off' ? trimSlash(env.MEDIA_URL) : null,
    mediaNamespace: env.MEDIA_NAMESPACE ?? 'games',
    worldSavedEventMinutes: intEnv(env, 'WORLD_SAVED_EVENT_MINUTES', 15),
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    port: intEnv(env, 'PORT', 8000),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? 'data/world.db',
    staticDir: env.STATIC_DIR ?? null,
    mapPath: env.MAP_PATH ?? 'data/map.json',
    /** Fallback admin secret for the map editor (until openvibe.network SSO). */
    editorKey: env.EDITOR_KEY ?? null,
    /** openvibe.network auth endpoint; when set, editor tokens validate there. */
    networkAuthUrl:
      env.OV_NETWORK_AUTH_URL ??
      (env.OV_OAUTH_CLIENT_SECRET
        ? `${env.OV_NETWORK_URL ?? 'https://openvibe.network'}/api/auth/me`
        : null),
    guestIpBinding: env.GUEST_IP_BINDING !== 'off',
    oauth: env.OV_OAUTH_CLIENT_SECRET
      ? {
          clientId: env.OV_OAUTH_CLIENT_ID ?? 'games',
          clientSecret: env.OV_OAUTH_CLIENT_SECRET,
          baseUrl: env.OV_NETWORK_URL ?? 'https://openvibe.network',
          selfUrl: env.SELF_URL ?? 'https://openvibe.games',
          playUrl: env.PLAY_URL ?? 'https://play.openvibe.games',
        }
      : null,
    platform: loadPlatformConfig(env),
    tickRate: 30,
    snapshotEvery: 2,
    interestRadius: intEnv(env, 'INTEREST_RADIUS', 80),
    maxPlayers: intEnv(env, 'MAX_PLAYERS', 64),
    persistFlushSeconds: intEnv(env, 'PERSIST_FLUSH_SECONDS', 10),
    metricsLogSeconds: intEnv(env, 'METRICS_LOG_SECONDS', 30),
    eventIntervalScale: env.EVENT_INTERVAL_SCALE ? Number(env.EVENT_INTERVAL_SCALE) : 1,
  }
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value)) throw new Error(`invalid ${key}: ${raw}`)
  return value
}

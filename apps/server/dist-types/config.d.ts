export interface ServerConfig {
    port: number;
    host: string;
    dbPath: string;
    /** Directory of built client assets to serve, or null for API/WS only. */
    staticDir: string | null;
    mapPath: string;
    editorKey: string | null;
    networkAuthUrl: string | null;
    /** Bind fresh guest tokens to client IPs (off in tests: peers share an IP). */
    guestIpBinding: boolean;
    /** openvibe.network OAuth client (SSO); null until the secret is configured. */
    oauth: {
        clientId: string;
        clientSecret: string;
        baseUrl: string;
        selfUrl: string;
        /** Public base of the play host (Host-routed game vhost). */
        playUrl: string;
    } | null;
    /**
     * Platform integration (roadmap Wave 12): Games calls OpenVibe services with
     * a client-credentials token of its own `games` principal. Everything here
     * is off until OV_OAUTH_CLIENT_SECRET (the same OAuth client as SSO) is set.
     */
    platform: PlatformConfig;
    tickRate: number;
    /** Send a snapshot every N ticks. */
    snapshotEvery: number;
    /** Entities beyond this distance from a player are not replicated to them. */
    interestRadius: number;
    maxPlayers: number;
    persistFlushSeconds: number;
    metricsLogSeconds: number;
    /** Multiplier on world-event cadences (tests shrink it). */
    eventIntervalScale: number;
}
export interface PlatformConfig {
    /** OAuth client id of the `games` principal (shared with SSO). */
    clientId: string;
    /** Its client secret; null = no service calls at all. */
    clientSecret: string | null;
    /** Network base for /oauth/token, identity and the JWKS (host-internal in production). */
    networkUrl: string;
    /** OpenVibe.Events base; null = no durable events (the outbox is not even created). */
    eventsUrl: string | null;
    /** OpenVibe.Media base; null = map assets stay local only. */
    mediaUrl: string | null;
    /** Media namespace (tenant app id) Games writes objects into. */
    mediaNamespace: string;
    /** At most one `games.world.saved` checkpoint event per this many minutes. */
    worldSavedEventMinutes: number;
}
export declare function loadPlatformConfig(env: NodeJS.ProcessEnv): PlatformConfig;
export declare function loadConfig(env: NodeJS.ProcessEnv): ServerConfig;
//# sourceMappingURL=config.d.ts.map
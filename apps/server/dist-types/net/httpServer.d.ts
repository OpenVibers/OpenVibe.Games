import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '@openvibe/shared';
import type { ServerMetrics } from '../observability/metrics.js';
import type { MapFileV2 } from '@openvibe/content';
export interface EditorAuth {
    /** Shared-secret fallback. */
    key: string | null;
    /** openvibe.network session endpoint; token validated there when configured. */
    networkAuthUrl: string | null;
}
/** openvibe.network OAuth2 client — powers the /auth/login → /auth/callback flow. */
export interface OAuthConfig {
    clientId: string;
    clientSecret: string;
    /** Public openvibe.network base, e.g. https://openvibe.network */
    baseUrl: string;
    /** Our public base, e.g. https://openvibe.games (redirect_uri host). */
    selfUrl: string;
    /** Public base of the play vhost, e.g. https://play.openvibe.games. */
    playUrl: string;
}
/** Platform seams (roadmap Wave 12): extra API routes and a stored-asset hook. */
export interface HttpPlatformHooks {
    /** Answers a request it owns (returns true), e.g. the mod registry API. */
    handle?: (req: IncomingMessage, res: ServerResponse) => boolean;
    /** A map asset was stored (or found already stored) locally. */
    onAssetStored?: (asset: {
        hash: string;
        url: string;
        bytes: number;
        mime: string;
    }) => void;
}
export declare function createHttpServer(staticDir: string | null, metrics: ServerMetrics, log: Logger, mapPath?: string, editorAuth?: EditorAuth, onMapSaved?: (next: MapFileV2, revision: string) => void, listCharacters?: (token: string, auth: string | undefined) => Promise<{
    slot: number;
    name: string;
    appearance: unknown;
}[]>, oauth?: OAuthConfig | null, platform?: HttpPlatformHooks): Server;
//# sourceMappingURL=httpServer.d.ts.map
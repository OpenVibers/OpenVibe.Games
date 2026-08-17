import { type Server } from 'node:http';
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
export declare function createHttpServer(staticDir: string | null, metrics: ServerMetrics, log: Logger, mapPath?: string, editorAuth?: EditorAuth, onMapSaved?: (next: MapFileV2, revision: string) => void, listCharacters?: (token: string, auth: string | undefined) => Promise<{
    slot: number;
    name: string;
    appearance: unknown;
}[]>, oauth?: OAuthConfig | null): Server;
//# sourceMappingURL=httpServer.d.ts.map
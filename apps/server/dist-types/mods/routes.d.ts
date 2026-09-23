/**
 * Mod registry HTTP API (JSON; errors are RFC 9457 problem+json with the
 * legacy `error` field).
 *
 *   GET    /api/v1/mods                         public: installs, status, grants
 *   GET    /api/v1/mods/:id                     public: one install incl. manifest + pack
 *   GET    /api/v1/mods/:id/audit?limit=        staff: install/grant/use/deny/revoke log
 *   POST   /api/v1/mods                         staff: { manifest, pack, approve[], trustTier, enable }
 *   POST   /api/v1/mods/:id/enable|disable      staff
 *   POST   /api/v1/mods/:id/revoke              staff: { reason? } — terminal
 *   POST   /api/v1/mods/:id/grants              staff: { capability }
 *   DELETE /api/v1/mods/:id/grants/:capability  staff
 *
 * Staff = an openvibe.network owner/admin session, or a service principal
 * whose token (audience openvibe.games) carries `games.mod.manage`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@openvibe/shared';
import { type ModActor, type ModRegistry, type ModView } from './registry.js';
export declare const MODS_PREFIX = "/api/v1/mods";
export interface ModsApi {
    registry: ModRegistry;
    /** Resolves the staff actor behind a request, or null. */
    authorize(req: IncomingMessage): Promise<ModActor | null>;
    log: Logger;
}
export declare function publicView(v: ModView): Record<string, unknown>;
/** Returns true when the request was a mods API request (handled or answered). */
export declare function handleModsRequest(req: IncomingMessage, res: ServerResponse, api: ModsApi): boolean;
//# sourceMappingURL=routes.d.ts.map
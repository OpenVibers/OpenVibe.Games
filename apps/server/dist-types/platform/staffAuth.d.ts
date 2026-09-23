import type { IncomingMessage } from 'node:http';
import { type UserTokenClaims } from 'openvibe-sdk/auth';
import type { ModActor } from '../mods/registry.js';
export declare const CAP_MOD_MANAGE = "games.mod.manage";
export declare const GAMES_AUDIENCE = "openvibe.games";
export interface StaffAuthOptions {
    /** openvibe.network /api/auth/me, or null in local development. */
    networkAuthUrl: string | null;
    /** Network base for the JWKS (`/api/.well-known/jwks`). */
    networkUrl: string;
    editorKey: string | null;
    /** Test seam: verifies a principal token. */
    verifyPrincipal?: (token: string) => Promise<UserTokenClaims>;
}
export declare function createStaffAuthorizer(opts: StaffAuthOptions): (req: IncomingMessage) => Promise<ModActor | null>;
//# sourceMappingURL=staffAuth.d.ts.map
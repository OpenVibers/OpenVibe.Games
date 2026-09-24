import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * GET /release.json (ADR-016, roadmap D43): what this deployment is, in the manifest shape the other
 * OpenVibe services serve through openvibe-shared/release. The release id is RELEASE_SHA when set,
 * otherwise the checked-out commit read from .git (no child process). Public deployment facts only.
 */
export interface ReleaseManifest {
    service: string;
    release: string;
    released_at: string | null;
    booted_at: string;
    contracts_version: string | null;
    packages: Record<string, string>;
    min_client_release: string | null;
    mixed_version_window_hours: number;
    components: Record<string, {
        kind: string;
        version: string;
    }>;
    schema_generation: null;
    schema_compatible_from: null;
    contract_ranges: Record<string, string>;
}
/** The commit checked out at `start` or the nearest parent with a .git (HEAD, a loose ref, or packed-refs), or null. */
export declare function gitCommit(start: string): string | null;
export declare function buildRelease(root: string, { env, now }?: {
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
}): ReleaseManifest;
/** Answers GET /release.json (returns true), else false. */
export declare function releaseHandler(manifest: ReleaseManifest): (req: IncomingMessage, res: ServerResponse) => boolean;
/** A request from this machine that did not come through the proxy (nginx sets the client-IP headers). */
export declare function isDirectLoopback(req: IncomingMessage): boolean;
//# sourceMappingURL=release.d.ts.map
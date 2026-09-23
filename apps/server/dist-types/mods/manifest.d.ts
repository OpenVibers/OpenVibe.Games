export interface ModManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    publisher: {
        type: string;
        id: string;
    };
    target: string;
    runtime: string;
    permissions: {
        capabilities: string[];
        events?: string[];
        modules?: string[];
        mediaNamespaces?: string[];
    };
    resources: {
        cpuMs: number;
        memoryMb: number;
        storageMb: number;
        outboundHosts?: string[];
    };
    assets?: {
        media_id: string;
        role?: string;
        variant?: string;
    }[];
    compatibility: {
        runtime: string;
        contracts?: string;
    };
    homepage?: string;
}
export type Validation<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    errors: string[];
};
/** Structural validation against mods/mod-manifest.v1. */
export declare function validateManifest(value: unknown): Validation<ModManifest>;
/** The browser game's only mod target and runtime today. */
export declare const GAMES_TARGET = "games.browser";
export declare const CONTENT_RUNTIME = "games-content@1";
/** Version of the content runtime, matched against compatibility.runtime. */
export declare const CONTENT_RUNTIME_VERSION = "1.0.0";
/**
 * Whether this server can run the manifest at all. Executable runtimes
 * (scripts) are refused here: they wait for OpenVibe.Host's sandbox
 * (Stage C). Only declarative content packs run in Games today.
 */
export declare function checkForGames(m: ModManifest): string[];
//# sourceMappingURL=manifest.d.ts.map
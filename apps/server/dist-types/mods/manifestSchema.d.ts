/**
 * The mod manifest JSON Schema (mods/mod-manifest.v1) as Games validates it.
 * The proposal for OpenVibe.Contracts is docs/contracts-proposal/mods/mod-manifest.v1.json;
 * manifest.test.ts fails if the two ever differ. Once Contracts releases the
 * schema, import it from openvibe-contracts instead of keeping this copy.
 */
export declare const MOD_MANIFEST_SCHEMA: {
    readonly $schema: "https://json-schema.org/draft/2020-12/schema";
    readonly $id: "https://openvibe.network/contracts/mods/mod-manifest.v1.json";
    readonly title: "ModManifest";
    readonly description: "A mod as the platform knows it (ADR-013): who publishes it, which runtime runs it, which capabilities it asks for and the resources it may use. Requested capabilities are only a request: the install's approved subset is the grant, and trust tiers are install metadata that never change a grant check. The runtime-specific payload (a data pack, a script bundle) is not part of the manifest.";
    readonly type: "object";
    readonly required: readonly ["id", "name", "version", "publisher", "target", "runtime", "permissions", "resources", "compatibility"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly id: {
            readonly type: "string";
            readonly pattern: "^mod_[0-9A-HJKMNP-TV-Z]{26}$";
            readonly description: "Stable mod id; its principal subject is mod:<id>.";
        };
        readonly name: {
            readonly type: "string";
            readonly minLength: 1;
            readonly maxLength: 80;
        };
        readonly version: {
            readonly type: "string";
            readonly pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$";
            readonly description: "Semantic version of this release.";
        };
        readonly description: {
            readonly type: "string";
            readonly maxLength: 1000;
        };
        readonly publisher: {
            readonly $ref: "../identity/subject-ref.v1.json";
            readonly description: "Who publishes the mod (a user or an app subject).";
        };
        readonly target: {
            readonly type: "string";
            readonly pattern: "^[a-z][a-z0-9-]{1,39}\\.[a-z][a-z0-9-]{1,39}$";
            readonly description: "Where the mod runs: <service>.<surface>, e.g. games.browser, games.source, live.overlay.";
        };
        readonly runtime: {
            readonly type: "string";
            readonly pattern: "^[a-z][a-z0-9-]{1,39}@[1-9][0-9]{0,3}$";
            readonly description: "Runtime adapter and its major version, e.g. games-content@1 (declarative data pack) or source-quickjs@1.";
        };
        readonly permissions: {
            readonly type: "object";
            readonly required: readonly ["capabilities"];
            readonly additionalProperties: false;
            readonly properties: {
                readonly capabilities: {
                    readonly description: "Capability ids the mod asks for (3+ segments). The target runtime binds only those it implements, and only once granted.";
                    readonly type: "array";
                    readonly maxItems: 64;
                    readonly uniqueItems: true;
                    readonly items: {
                        readonly type: "string";
                        readonly pattern: "^[a-z][a-z0-9_]*(\\.[a-z0-9_]+){2,}$";
                    };
                };
                readonly events: {
                    readonly description: "Event types the mod wants delivered to it.";
                    readonly type: "array";
                    readonly maxItems: 64;
                    readonly uniqueItems: true;
                    readonly items: {
                        readonly type: "string";
                        readonly pattern: "^[a-z][a-z0-9_]*(\\.[a-z0-9_]+){2,}$";
                    };
                };
                readonly modules: {
                    readonly description: "User-module namespaces the mod wants to read or write (a trailing .* names a family).";
                    readonly type: "array";
                    readonly maxItems: 32;
                    readonly uniqueItems: true;
                    readonly items: {
                        readonly type: "string";
                        readonly pattern: "^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*(\\.\\*)?$";
                    };
                };
                readonly mediaNamespaces: {
                    readonly description: "Media namespaces the mod wants to read or write.";
                    readonly type: "array";
                    readonly maxItems: 32;
                    readonly uniqueItems: true;
                    readonly items: {
                        readonly type: "string";
                        readonly pattern: "^[a-z][a-z0-9_-]*(\\.[a-z0-9_-]+)*$";
                    };
                };
            };
        };
        readonly resources: {
            readonly type: "object";
            readonly required: readonly ["cpuMs", "memoryMb", "storageMb"];
            readonly additionalProperties: false;
            readonly description: "The budget the mod asks for. Runtimes meter it; the sandbox that enforces it lives in OpenVibe.Host (Stage C).";
            readonly properties: {
                readonly cpuMs: {
                    readonly type: "number";
                    readonly minimum: 0;
                    readonly maximum: 1000;
                    readonly description: "CPU milliseconds per tick (game runtimes) or per request.";
                };
                readonly memoryMb: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: 4096;
                };
                readonly storageMb: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: 102400;
                };
                readonly outboundHosts: {
                    readonly description: "Hosts the mod may reach over the network. Empty or absent = none.";
                    readonly type: "array";
                    readonly maxItems: 32;
                    readonly uniqueItems: true;
                    readonly items: {
                        readonly type: "string";
                        readonly pattern: "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$";
                    };
                };
            };
        };
        readonly assets: {
            readonly description: "Assets the mod ships, as Media object references.";
            readonly type: "array";
            readonly maxItems: 256;
            readonly items: {
                readonly $ref: "../media/media-ref.v1.json";
            };
        };
        readonly compatibility: {
            readonly type: "object";
            readonly required: readonly ["runtime"];
            readonly additionalProperties: false;
            readonly properties: {
                readonly runtime: {
                    readonly type: "string";
                    readonly minLength: 1;
                    readonly maxLength: 100;
                    readonly description: "Semver range of the runtime this release works with, e.g. \">=1.0.0 <2.0.0\".";
                };
                readonly contracts: {
                    readonly type: "string";
                    readonly minLength: 1;
                    readonly maxLength: 100;
                    readonly description: "Semver range of openvibe-contracts releases it was built against.";
                };
            };
        };
        readonly homepage: {
            readonly type: "string";
            readonly pattern: "^https://[^\\s]{1,2000}$";
        };
    };
};
//# sourceMappingURL=manifestSchema.d.ts.map
/**
 * `games-content@1`: the first mod kind — a declarative data pack, checked
 * against the live `@openvibe/content` registry. It adds no code and no new
 * definitions (the client ships the same registry, so a pack can only use
 * what both sides already know). Each section needs one capability:
 *
 *   announcements  games.world.announce   periodic server announcements
 *   props          games.prop.place       inert props placed in the world
 *
 * Mod props are owned by the mod, so prop protection keeps players from
 * picking them up, moving or welding them, and only items without health,
 * storage, shops, machines or vehicle parts may be placed: nothing a player
 * could destroy for loot or use to move items into or out of the world.
 */
import type { ContentRegistry } from '@openvibe/content';
import type { Validation } from './manifest.js';
export declare const CAP_ANNOUNCE = "games.world.announce";
export declare const CAP_PLACE_PROP = "games.prop.place";
/** Capabilities the games-content@1 runtime can bind. Anything else is never granted here. */
export declare const CONTENT_RUNTIME_CAPABILITIES: readonly string[];
export interface ContentAnnouncement {
    text: string;
    everySeconds: number;
}
export interface ContentProp {
    key: string;
    item: string;
    pos: [number, number, number];
    yaw?: number;
}
export interface ContentPack {
    announcements?: ContentAnnouncement[];
    props?: ContentProp[];
}
export declare const CONTENT_PACK_SCHEMA: {
    readonly $schema: "https://json-schema.org/draft/2020-12/schema";
    readonly $id: "https://openvibe.games/schemas/games-content-pack.v1.json";
    readonly title: "GamesContentPack";
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly announcements: {
            readonly type: "array";
            readonly maxItems: 10;
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["text", "everySeconds"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly text: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 200;
                    };
                    readonly everySeconds: {
                        readonly type: "integer";
                        readonly minimum: 60;
                        readonly maximum: 86400;
                    };
                };
            };
        };
        readonly props: {
            readonly type: "array";
            readonly maxItems: 50;
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["key", "item", "pos"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly key: {
                        readonly type: "string";
                        readonly pattern: "^[a-z0-9][a-z0-9_-]{0,39}$";
                    };
                    readonly item: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 64;
                    };
                    readonly pos: {
                        readonly type: "array";
                        readonly minItems: 3;
                        readonly maxItems: 3;
                        readonly items: {
                            readonly type: "number";
                            readonly minimum: -4096;
                            readonly maximum: 4096;
                        };
                    };
                    readonly yaw: {
                        readonly type: "number";
                        readonly minimum: -10;
                        readonly maximum: 10;
                    };
                };
            };
        };
    };
};
/** Which capability each pack section needs. */
export declare function capabilitiesUsedBy(pack: ContentPack): string[];
/** Whether a content item may be placed as a mod prop (see the file comment). */
export declare function placeableByMod(content: ContentRegistry, itemId: string): string | null;
/** Structure (JSON Schema) plus the content-registry cross-checks. */
export declare function validateContentPack(value: unknown, content: ContentRegistry): Validation<ContentPack>;
//# sourceMappingURL=contentPack.d.ts.map
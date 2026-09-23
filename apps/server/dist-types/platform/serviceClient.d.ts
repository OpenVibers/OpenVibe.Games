import { type FetchLike, type OpenVibeClient } from 'openvibe-sdk/core';
import type { PlatformConfig } from '../config.js';
export interface PlatformClient {
    client: OpenVibeClient;
    clientId: string;
}
/** Null when no client secret is configured: Games then makes no service calls. */
export declare function createPlatformClient(cfg: PlatformConfig, fetchImpl?: FetchLike): PlatformClient | null;
//# sourceMappingURL=serviceClient.d.ts.map
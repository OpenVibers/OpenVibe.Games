import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
/**
 * Graceful stop (roadmap WS-P lifecycle; openvibe-contracts manifests/services/games.json →
 * lifecycle.shutdown). main.ts runs the order; these are the network halves of it.
 *
 * The unit's TimeoutStopSec is 30: the whole stop is bounded by DEADLINE_MS (the manifest's
 * deadlineSeconds), well inside it. Requests in flight get DRAIN_MS; sockets that do not answer the
 * close handshake within SOCKETS_MS are terminated.
 */
export declare const DEADLINE_MS = 10000;
export declare const DRAIN_MS = 5000;
export declare const SOCKETS_MS = 3000;
/** WebSocket close code for "service restart" (RFC 6455 registry): the clients reconnect on their own. */
export declare const CLOSE_RESTART = 1012;
export interface HttpDrainer {
    /**
     * Stop taking connections, close idle keep-alive ones, answer every request in flight with
     * Connection: close. Resolves 0 once every connection has ended, or after `ms` with how many
     * requests were still open (their connections are then cut).
     */
    close(ms: number): Promise<number>;
    stopping(): boolean;
}
/** Tracks responses in flight on `server`. Attach before the server takes requests. */
export declare function httpDrainer(server: Server): HttpDrainer;
/**
 * Close every client of `wss` with 1012 (service restart) and `reason`; a client that has not
 * finished the close handshake after `ms` is terminated. Resolves once every one has closed (its
 * 'close' handlers have run).
 */
export declare function closeSockets(wss: WebSocketServer, ms: number, reason?: string): Promise<{
    closed: number;
    terminated: number;
}>;
/** Await `p`, but no longer than `ms`. */
export declare function within<T>(ms: number, p: Promise<T> | undefined | null): Promise<T | undefined>;
//# sourceMappingURL=gracefulStop.d.ts.map
import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * The answer for a path no route matches: a real 404, never the landing page
 * with a 200 (a "soft 404" that search engines index as a duplicate of the
 * portal and monitors read as up).
 *
 * Page requests get a small self-contained HTML page that names the path and
 * links to the host's real entry points. API paths and clients asking for
 * JSON get `{"error":"not_found"}` (the shape /auth/* already answers). A
 * missing asset (any extension but .html) gets plain text.
 */
export interface NotFoundLink {
    href: string;
    label: string;
}
export type NotFoundKind = 'html' | 'json' | 'text';
export declare function escapeHtml(value: string): string;
/** Which body a 404 for `path` gets. */
export declare function notFoundKind(req: IncomingMessage, path: string): NotFoundKind;
export declare function notFoundPage(path: string, links: readonly NotFoundLink[]): string;
/** Answers 404 for `path` with the body its client can use; HEAD gets the headers only. */
export declare function sendNotFound(req: IncomingMessage, res: ServerResponse, path: string, links: readonly NotFoundLink[]): void;
//# sourceMappingURL=notFound.d.ts.map
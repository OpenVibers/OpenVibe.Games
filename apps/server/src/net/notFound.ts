import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'

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
  href: string
  label: string
}

export type NotFoundKind = 'html' | 'json' | 'text'

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c)
}

/** Which body a 404 for `path` gets. */
export function notFoundKind(req: IncomingMessage, path: string): NotFoundKind {
  if (path === '/api' || path.startsWith('/api/')) return 'json'
  const accept = (req.headers.accept ?? '').toLowerCase()
  if (accept.includes('application/json') && !accept.includes('text/html')) return 'json'
  const ext = extname(path).toLowerCase()
  if (ext !== '' && ext !== '.html' && ext !== '.htm') return 'text'
  return 'html'
}

/** Longest request path echoed back on the page; the rest is cut. */
const MAX_SHOWN_PATH = 200

export function notFoundPage(path: string, links: readonly NotFoundLink[]): string {
  const shown = path.length > MAX_SHOWN_PATH ? `${path.slice(0, MAX_SHOWN_PATH)}…` : path
  const items = links
    .map((l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></li>`)
    .join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found · OpenVibe.Games</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
  font-family: system-ui, -apple-system, sans-serif; background: #0a0f1c; color: #e6edf7; }
main { width: 100%; max-width: 32rem; padding: 32px 28px; border: 1px solid #1f2d47;
  border-radius: 14px; background: #101828; }
.code { font-size: 0.8rem; font-weight: 700; letter-spacing: 0.12em; color: #60a5fa; }
h1 { margin: 6px 0 12px; font-size: 1.6rem; }
p { color: #96a7c2; line-height: 1.5; }
code { color: #e6edf7; word-break: break-all; }
ul { list-style: none; padding: 0; margin-top: 22px; display: flex; flex-wrap: wrap; gap: 10px; }
a { display: inline-block; padding: 8px 14px; border-radius: 8px; background: #1d4ed8;
  color: #fff; text-decoration: none; font-weight: 600; }
a:hover, a:focus-visible { background: #3b82f6; }
</style>
</head>
<body>
<main>
<p class="code">404</p>
<h1>Page not found</h1>
<p>There is no page at <code>${escapeHtml(shown)}</code>. It may have moved, or the link may be wrong.</p>
<ul>${items}</ul>
</main>
</body>
</html>
`
}

/** Answers 404 for `path` with the body its client can use; HEAD gets the headers only. */
export function sendNotFound(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  links: readonly NotFoundLink[],
): void {
  const kind = notFoundKind(req, path)
  const body =
    kind === 'html'
      ? notFoundPage(path, links)
      : kind === 'json'
        ? '{"error":"not_found"}'
        : 'not found\n'
  res.writeHead(404, {
    'content-type':
      kind === 'html'
        ? 'text/html; charset=utf-8'
        : kind === 'json'
          ? 'application/json'
          : 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

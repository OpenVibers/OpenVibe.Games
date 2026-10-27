import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CREATOR_MAP_LIMITS,
  CREATOR_SCRIPT_LIMITS,
  CREATOR_WORLD_ID,
  creatorMapIssues,
  creatorScriptsOf,
  starterCreatorMap,
  parseMapFile,
  type MapFileV2,
} from '@openvibe/content'
import type {
  CreatorWorld,
  CreatorWorldStatus,
  CreatorWorldStore,
  CreatorWorldView,
} from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import type { Db, Tx } from 'openvibe-sdk/db'
import type { EventInput } from 'openvibe-sdk/events'
import {
  actorFor,
  moderationEvent,
  worldPublishedEvent,
  type EventSink,
} from '../platform/gameEvents.js'
import type { GamesActorLimits } from '../net/actorLimits.js'
import type { NetworkUser } from '../net/networkAuth.js'
import type { WorldSearchIndex } from './searchIndex.js'

/**
 * /api/worlds: creator worlds (migration 0010). Anyone reads the published list and plays a published world; a
 * signed-in person (a Network account, not a guest) makes up to `perPerson` worlds, edits their maps in /editor and
 * publishes them; staff hide a world. Every write is counted per person (games.world.write, games.map.save).
 *
 *   GET    /api/worlds[?page=]        published worlds, newest first
 *   GET    /api/worlds/mine           the caller's worlds
 *   POST   /api/worlds                { title, summary? } → a new draft with an empty map
 *   GET    /api/worlds/:id            one world (published, or the caller's, or staff)
 *   GET    /api/worlds/:id/map        its map document, ETag = revision
 *   PUT    /api/worlds/:id/map        the owner saves (If-Match: revision); a running world reloads at once
 *   PATCH  /api/worlds/:id            { title?, summary?, status?, view? } owner: draft|published, 3d|top; staff: hidden|published
 *   DELETE /api/worlds/:id            the owner or games staff
 */

/** The running worlds, as the routes see them (main.ts runs the changes in the router's admission chain). */
export interface WorldHostView {
  online(): Map<string, number>
  applyMap(id: string, map: MapFileV2): void
  changed(world: CreatorWorld | null, id: string): Promise<void>
  /**
   * Stops the world (its last save lands) and removes it with its place's rows; `within` runs in the transaction
   * that removes it (a staff deletion's moderation event).
   */
  remove(id: string, within?: (t: Tx) => Promise<void>): Promise<void>
  /** The world's scripts changed: a running world says so and stops, and the next join runs the new ones. */
  scriptsChanged(id: string): Promise<void>
}

export interface WorldRouteOptions {
  store: CreatorWorldStore
  host: WorldHostView
  /** The Network account behind a bearer token (networkAuth.resolveNetworkUser), or null. */
  resolveUser: (token: string) => Promise<NetworkUser | null>
  limits: GamesActorLimits
  address: (req: IncomingMessage) => string
  log: Logger
  perPerson: number
  /**
   * Events through Games' outbox, each in the transaction of the change it describes: games.world.published on a
   * world's first publication, games.moderation.action when staff hide, restore or delete someone else's world.
   */
  events?: { db: Db; sink: EventSink; siteUrl: string }
  /** Published worlds in OpenVibe.Search (searchIndex.ts), synced in the same transaction as the events. */
  search?: WorldSearchIndex
  /** Whether worlds' scripts run here (GAMES_CREATOR_SCRIPTS); they are kept either way. */
  scriptsRun?: boolean
  now?: () => number
}

const PAGE_SIZE = 24
/** A world's editors besides its owner; an invite link works this long (owner, 2026-10-27: "make teams"). */
const TEAM_MAX = 8
const INVITE_MS = 7 * 24 * 60 * 60 * 1000
const inviteHash = (token: string): string => createHash('sha256').update(token).digest('hex')
const META_BYTES = 16 * 1024
const TITLE_MAX = 60
const SUMMARY_MAX = 280

type Problem = {
  status: number
  error: string
  detail?: string
  issues?: string[]
  revision?: string
}

export class RouteError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.error)
  }
}

export const fail = (
  status: number,
  error: string,
  extra: Omit<Problem, 'status' | 'error'> = {},
): never => {
  throw new RouteError({ status, error, ...extra })
}

/** Plain text of at most `max` characters: trimmed, control characters out, inner runs of space kept to one. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const visible = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : ch
  }).join('')
  const text = visible.replace(/\s+/g, ' ').trim()
  return text.length > max ? null : text
}

export function isStaff(user: NetworkUser | null): boolean {
  return user?.rank === 'owner' || user?.rank === 'admin' || user?.rank === 'moderator'
}

export function isGamesStaff(user: NetworkUser | null): boolean {
  return user?.rank === 'owner' || user?.rank === 'admin'
}

function publicView(world: CreatorWorld, online: number) {
  return {
    id: world.id,
    title: world.title,
    summary: world.summary,
    owner: world.ownerName,
    plays: world.plays,
    online,
    published_at: world.publishedAt === null ? null : new Date(world.publishedAt).toISOString(),
    updated_at: new Date(world.updatedAt).toISOString(),
    play_url: `/play?world=${world.id}`,
    // A remix credits the world it copied (as it was then); remixes counts how often others copied this one.
    remixed_from: world.remixedFrom
      ? {
          id: world.remixedFrom.id,
          title: world.remixedFrom.title,
          owner: world.remixedFrom.owner,
          url: `/worlds/${world.remixedFrom.id}`,
        }
      : null,
    remixes: world.remixes,
    // '3d' (first person) or 'top' (straight down on the player, a 2D view; migration 0017).
    view: world.view,
  }
}

function ownerView(world: CreatorWorld, online: number) {
  return {
    ...publicView(world, online),
    status: world.status,
    revision: world.revision,
    created_at: new Date(world.createdAt).toISOString(),
    edit_url: `/editor?world=${world.id}`,
  }
}

/** An If-Match header as a bare revision: Cloudflare hands the browser a weak `W/"…"` form of the ETag. */
export function parseIfMatch(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header
  const value = String(raw ?? '')
    .trim()
    .replace(/^W\//, '')
    .replace(/"/g, '')
  return value || null
}

export function readBody(
  req: IncomingMessage,
  max: number,
): Promise<{ text: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        over = true
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), bytes: size }))
    req.on('close', () => {
      if (over) reject(new RouteError({ status: 413, error: 'too_large' }))
    })
    req.on('error', reject)
  })
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return fail(400, 'invalid_json')
  }
}

export function createWorldRoutes(opts: WorldRouteOptions) {
  const now = opts.now ?? Date.now
  const online = (id: string): number => opts.host.online().get(id) ?? 0
  /** Runs a change with its events in one transaction (or without events when the outbox is off). */
  const withEvents = <T>(
    fn: (enqueue: (event: EventInput) => Promise<void>, t: Tx | null) => Promise<T>,
  ): Promise<T> => {
    const events = opts.events?.sink.enabled ? opts.events : null
    return events
      ? events.db.tx((t) => fn((event) => events.sink.enqueue(t, event), t))
      : fn(async () => {}, null)
  }

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    })
    res.end(JSON.stringify(body))
  }

  const bearer = (req: IncomingMessage): string | null =>
    /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null

  /** The caller's Network account, or null for a guest / no token. */
  const caller = async (req: IncomingMessage): Promise<NetworkUser | null> => {
    const token = bearer(req)
    if (!token) return null
    const user = await opts.resolveUser(token)
    return user?.subjectId ? user : null
  }

  const signedIn = async (req: IncomingMessage): Promise<NetworkUser & { subjectId: string }> => {
    const user = await caller(req)
    if (!user?.subjectId)
      fail(401, 'sign_in_required', { detail: 'Sign in with your OpenVibe account.' })
    return user as NetworkUser & { subjectId: string }
  }

  /** A world the caller may see: published, or theirs, or staff. Anything else is not found. */
  const visible = async (id: string, user: NetworkUser | null): Promise<CreatorWorld> => {
    const world = CREATOR_WORLD_ID.test(id) ? await opts.store.get(id) : null
    if (!world) return fail(404, 'world_not_found')
    if (world.status === 'published' || isStaff(user) || world.ownerSubject === user?.subjectId)
      return world
    if (user?.subjectId && (await opts.store.isMember(world.id, user.subjectId))) return world
    return fail(404, 'world_not_found')
  }

  /** A world the caller may build: theirs, or one whose team they are on. */
  const editable = async (
    id: string,
    user: NetworkUser & { subjectId: string },
  ): Promise<{ world: CreatorWorld; role: 'owner' | 'editor' }> => {
    const world = CREATOR_WORLD_ID.test(id) ? await opts.store.get(id) : null
    if (!world) return fail(404, 'world_not_found')
    if (world.ownerSubject === user.subjectId) return { world, role: 'owner' }
    if (await opts.store.isMember(world.id, user.subjectId)) return { world, role: 'editor' }
    return fail(404, 'world_not_found')
  }

  const limited = (
    kind: 'publicRead' | 'mapSave',
    req: IncomingMessage,
    res: ServerResponse,
    actor: string,
  ): Promise<boolean> => opts.limits[kind](req, res, actor)

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/api/worlds' && method === 'GET') {
      if (!(await limited('publicRead', req, res, `ip:${opts.address(req)}`))) return
      const page = Number(url.searchParams.get('page') ?? '1')
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) fail(400, 'invalid_query')
      const rows = await opts.store.listPublished(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE)
      send(res, 200, {
        worlds: rows.slice(0, PAGE_SIZE).map((w) => publicView(w, online(w.id))),
        page,
        more: rows.length > PAGE_SIZE,
      })
      return
    }

    if (path === '/api/worlds/mine' && method === 'GET') {
      const user = await signedIn(req)
      const worlds = await opts.store.listByOwner(user.subjectId)
      const team = await opts.store.listByMember(user.subjectId)
      send(res, 200, {
        worlds: worlds.map((w) => ownerView(w, online(w.id))),
        // Worlds on someone else's team: edit and try them; their owner publishes, renames and deletes.
        team: team.map((w) => ({ ...ownerView(w, online(w.id)), role: 'editor' })),
        max: opts.perPerson,
        limits: CREATOR_MAP_LIMITS,
        staff: isStaff(user),
      })
      return
    }

    if (path === '/api/worlds' && method === 'POST') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const body = parseJson((await readBody(req, META_BYTES)).text) as Record<
        string,
        unknown
      > | null
      const title = cleanText(body?.title, TITLE_MAX)
      const summary = body?.summary === undefined ? '' : cleanText(body.summary, SUMMARY_MAX)
      if (!title) fail(422, 'invalid_title', { detail: `A title of 1 to ${TITLE_MAX} characters.` })
      if (summary === null)
        fail(422, 'invalid_summary', { detail: `At most ${SUMMARY_MAX} characters.` })
      if ((await opts.store.countByOwner(user.subjectId)) >= opts.perPerson)
        fail(409, 'world_limit', {
          detail: `You can keep ${opts.perPerson} worlds. Delete one to make another.`,
        })
      const world = await opts.store.create({
        ownerSubject: user.subjectId,
        ownerName: user.name,
        title: title as string,
        summary: summary as string,
        map: starterCreatorMap(),
        now: now(),
      })
      opts.log.info('creator world created', { world: world.id })
      send(res, 201, ownerView(world, 0))
      return
    }

    // POST /api/worlds/:id/remix: a published world (or one of your own) copied into a new draft of yours, credited
    // (owner, 2026-10-27: "other people can make games just like the same way you can copy our game"). The copy is
    // yours to change and publish; the original is untouched and counts the remix.
    const remix = /^\/api\/worlds\/([^/]+)\/remix$/.exec(path)
    if (remix && method === 'POST') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const source = await opts.store.get(remix[1] ?? '')
      const own = !!source && source.ownerSubject === user.subjectId
      if (!source || (source.status !== 'published' && !own)) fail(404, 'not_found')
      if ((await opts.store.countByOwner(user.subjectId)) >= opts.perPerson)
        fail(409, 'world_limit', {
          detail: `You can keep ${opts.perPerson} worlds. Delete one to make another.`,
        })
      const stored = await opts.store.map((source as CreatorWorld).id)
      if (!stored) fail(404, 'not_found')
      const src = source as CreatorWorld
      const world = await opts.store.create({
        ownerSubject: user.subjectId,
        ownerName: user.name,
        title: `${src.title.slice(0, TITLE_MAX - 8).trimEnd()} (remix)`,
        summary: src.summary,
        map: (stored as { map: unknown }).map,
        now: now(),
        remixedFrom: { id: src.id, title: src.title, owner: src.ownerName },
        view: src.view,
      })
      if (!own) await opts.store.countRemix(src.id)
      opts.log.info('creator world remixed', { world: world.id, from: src.id })
      send(res, 201, ownerView(world, 0))
      return
    }

    // GET/PUT /api/worlds/:id/scripts: the world's own games-quickjs@1 mods (docs/mods.md "Scripts in creator worlds"),
    // the owner's to change and staff's to read. A save that passes the content package's checks stops a running world
    // (it says so first) so the next join runs the new scripts. `running` says whether this server runs them at all.
    const scriptsMatch = /^\/api\/worlds\/([^/]+)\/scripts$/.exec(path)
    if (scriptsMatch && (method === 'GET' || method === 'PUT')) {
      const user = await signedIn(req)
      const sid = scriptsMatch[1] ?? ''
      if (method === 'GET') {
        const world = CREATOR_WORLD_ID.test(sid) ? await opts.store.get(sid) : null
        const onTeam = !!world && (await opts.store.isMember(world.id, user.subjectId))
        if (!world || (world.ownerSubject !== user.subjectId && !onTeam && !isStaff(user)))
          fail(404, 'world_not_found')
        send(res, 200, {
          scripts: (await opts.store.scripts(sid)) ?? [],
          limits: CREATOR_SCRIPT_LIMITS,
          running: opts.scriptsRun === true,
        })
        return
      }
      await editable(sid, user)
      if (!(await limited('mapSave', req, res, `world:${user.subjectId}`))) return
      const { text } = await readBody(req, CREATOR_SCRIPT_LIMITS.bytes + 16 * 1024)
      const body = parseJson(text) as { scripts?: unknown } | null
      const checked = creatorScriptsOf(body?.scripts)
      if (checked.issues.length)
        fail(422, 'scripts_invalid', { issues: checked.issues.slice(0, 40) })
      // Stored as the creator wrote them; the server sets `granted` when it loads them.
      const stored = checked.scripts.map(({ granted: _granted, ...mod }) => mod)
      const saved = await opts.store.saveScripts(sid, stored, now())
      if (!saved) fail(404, 'world_not_found')
      await opts.host.scriptsChanged(sid)
      opts.log.info('creator world scripts saved', { world: sid, scripts: stored.length })
      send(res, 200, { scripts: stored, running: opts.scriptsRun === true })
      return
    }

    // ── The team (migration 0015): editors besides the owner, who join through the owner's invite link ──
    //   GET    /api/worlds/:id/team             → { owner, members, invite_expires_at? } (owner and editors)
    //   POST   /api/worlds/:id/invite           → { token, url, expires_at } (owner; a new link replaces the old)
    //   DELETE /api/worlds/:id/invite           → stops the link (owner)
    //   POST   /api/worlds/join { token }       → joins the team; answers the world as its editor sees it
    //   DELETE /api/worlds/:id/team/:subject    → the owner removes an editor, or an editor leaves
    if (path === '/api/worlds/join' && method === 'POST') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const body = parseJson((await readBody(req, META_BYTES)).text) as { token?: unknown } | null
      const token = typeof body?.token === 'string' ? body.token : ''
      const world = /^[A-Za-z0-9_-]{20,64}$/.test(token)
        ? await opts.store.byInvite(inviteHash(token), now())
        : null
      if (!world)
        fail(404, 'invite_not_found', { detail: 'That invite link has run out or was stopped.' })
      const w = world as CreatorWorld
      if (w.ownerSubject !== user.subjectId) {
        const members = await opts.store.members(w.id)
        if (!members.some((m) => m.subject === user.subjectId) && members.length >= TEAM_MAX)
          fail(409, 'team_full', {
            detail: `A world's team takes ${TEAM_MAX} people besides its owner.`,
          })
        await opts.store.addMember(w.id, user.subjectId, user.name, now())
        opts.log.info('creator world team joined', { world: w.id })
      }
      send(res, 200, {
        ...ownerView(w, online(w.id)),
        role: w.ownerSubject === user.subjectId ? 'owner' : 'editor',
      })
      return
    }
    const teamMatch = /^\/api\/worlds\/([^/]+)\/(team|invite)(?:\/([^/]+))?$/.exec(path)
    if (teamMatch) {
      const user = await signedIn(req)
      const [, tid = '', what, who] = teamMatch
      const { world, role } = await editable(tid, user)
      if (what === 'team' && method === 'GET' && who === undefined) {
        const members = await opts.store.members(world.id)
        send(res, 200, {
          owner: world.ownerName,
          role,
          max: TEAM_MAX,
          members: members.map((m) => ({
            subject: m.subject,
            name: m.name,
            added_at: new Date(m.addedAt).toISOString(),
          })),
          ...(role === 'owner'
            ? {
                invite_expires_at: await opts.store
                  .inviteExpires(world.id, now())
                  .then((at) => (at ? new Date(at).toISOString() : null)),
              }
            : {}),
        })
        return
      }
      if (what === 'team' && method === 'DELETE' && who !== undefined) {
        // `me` is the caller (an editor leaving); the owner removes anyone by subject.
        const target = who === 'me' ? user.subjectId : who
        if (role !== 'owner' && target !== user.subjectId) fail(404, 'not_found')
        await opts.store.removeMember(world.id, target)
        send(res, 200, { ok: true })
        return
      }
      if (what === 'invite' && who === undefined && (method === 'POST' || method === 'DELETE')) {
        if (role !== 'owner') fail(404, 'not_found')
        if (method === 'DELETE') {
          await opts.store.setInvite(world.id, null, null)
          send(res, 200, { ok: true })
          return
        }
        const token = randomBytes(24).toString('base64url')
        const expires = now() + INVITE_MS
        await opts.store.setInvite(world.id, inviteHash(token), expires)
        send(res, 201, {
          token,
          url: `/worlds?join=${token}`,
          expires_at: new Date(expires).toISOString(),
        })
        return
      }
      fail(404, 'not_found')
    }

    const match = /^\/api\/worlds\/([^/]+)(\/map)?$/.exec(path)
    if (!match) fail(404, 'not_found')
    const id = match?.[1] ?? ''
    const isMap = match?.[2] === '/map'

    if (isMap && method === 'GET') {
      const user = await caller(req)
      if (!user && !(await limited('publicRead', req, res, `ip:${opts.address(req)}`))) return
      await visible(id, user)
      const stored = await opts.store.map(id)
      if (!stored) fail(404, 'world_not_found')
      send(res, 200, stored?.map, { etag: `"${stored?.revision}"`, 'cache-control': 'no-cache' })
      return
    }

    if (isMap && (method === 'PUT' || method === 'POST')) {
      const user = await signedIn(req)
      await editable(id, user)
      if (!(await limited('mapSave', req, res, `world:${user.subjectId}`))) return
      const { text, bytes } = await readBody(req, CREATOR_MAP_LIMITS.bytes + 64 * 1024)
      const parsed = parseMapFile(parseJson(text))
      if (!parsed.ok) fail(422, 'map_invalid', { issues: parsed.issues.slice(0, 40) })
      const map = (parsed as { map: MapFileV2 }).map
      const issues = creatorMapIssues(map, bytes)
      if (issues.length) fail(422, 'map_invalid', { issues })
      const { revision: _client, ...doc } = map
      const ifMatch = parseIfMatch(req.headers['if-match'])
      const saved = await opts.store.saveMap(id, doc, ifMatch, now())
      if (saved === null) fail(404, 'world_not_found')
      if (saved === 'conflict') {
        const current = await opts.store.get(id)
        fail(409, 'stale_revision', current ? { revision: current.revision } : {})
      }
      const world = saved as CreatorWorld
      void opts.store.rename(user.subjectId, user.name).catch(() => undefined)
      opts.host.applyMap(id, doc as MapFileV2)
      send(
        res,
        200,
        { ok: true, live: true, revision: world.revision },
        { etag: `"${world.revision}"` },
      )
      return
    }

    if (!isMap && method === 'GET') {
      const user = await caller(req)
      if (!user && !(await limited('publicRead', req, res, `ip:${opts.address(req)}`))) return
      const world = await visible(id, user)
      const mine = user?.subjectId === world.ownerSubject
      send(
        res,
        200,
        mine || isStaff(user) ? ownerView(world, online(id)) : publicView(world, online(id)),
      )
      return
    }

    if (!isMap && method === 'PATCH') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const body = parseJson((await readBody(req, META_BYTES)).text) as Record<
        string,
        unknown
      > | null
      const world = CREATOR_WORLD_ID.test(id) ? await opts.store.get(id) : null
      const mine = !!world && world.ownerSubject === user.subjectId
      if (!world || (!mine && !isStaff(user))) return fail(404, 'world_not_found')
      const patch: {
        title?: string
        summary?: string
        status?: CreatorWorldStatus
        view?: CreatorWorldView
      } = {}
      if (body?.title !== undefined) {
        if (!mine) fail(403, 'owner_only')
        const title = cleanText(body.title, TITLE_MAX)
        if (!title)
          fail(422, 'invalid_title', { detail: `A title of 1 to ${TITLE_MAX} characters.` })
        patch.title = title as string
      }
      if (body?.summary !== undefined) {
        if (!mine) fail(403, 'owner_only')
        const summary = cleanText(body.summary, SUMMARY_MAX)
        if (summary === null)
          fail(422, 'invalid_summary', { detail: `At most ${SUMMARY_MAX} characters.` })
        patch.summary = summary as string
      }
      if (body?.view !== undefined) {
        if (!mine) fail(403, 'owner_only')
        if (body.view !== '3d' && body.view !== 'top')
          fail(422, 'invalid_view', { detail: 'A view is 3d or top.' })
        patch.view = body.view as CreatorWorldView
      }
      if (body?.status !== undefined) {
        const status = body.status
        if (status !== 'draft' && status !== 'published' && status !== 'hidden')
          fail(422, 'invalid_status')
        if (isStaff(user) && !mine) {
          // Staff take a world down or put it back; they never edit it.
          if (status === 'draft') fail(422, 'invalid_status')
        } else {
          if (status === 'hidden') fail(403, 'staff_only')
          if (world.status === 'hidden')
            fail(403, 'world_hidden', {
              detail: 'Staff took this world down. Ask on openvibe.help to bring it back.',
            })
        }
        patch.status = status as CreatorWorldStatus
      }
      const updated = await withEvents(async (enqueue, t) => {
        const next = await opts.store.update(id, patch, now())
        if (!next) return null
        // Search follows what the page shows: a published world's title and summary, or a tombstone.
        if (t && opts.search) await opts.search.sync(t, next)
        if (mine && patch.status === 'published' && world.publishedAt === null)
          await enqueue(worldPublishedEvent(next, opts.events?.siteUrl ?? ''))
        if (!mine && patch.status && patch.status !== world.status)
          await enqueue(
            moderationEvent(
              patch.status === 'hidden' ? 'world.hidden' : 'world.restored',
              { type: 'world', id, ownerSubject: world.ownerSubject },
              actorFor(user.subjectId),
              { details: { from: world.status, to: patch.status } },
            ),
          )
        return next
      })
      if (!updated) fail(404, 'world_not_found')
      if (mine) void opts.store.rename(user.subjectId, user.name).catch(() => undefined)
      if (patch.status && patch.status !== world.status) {
        opts.log.info('creator world status', {
          world: id,
          from: world.status,
          to: patch.status,
          staff: !mine,
        })
        await opts.host.changed(updated, id)
      }
      send(res, 200, ownerView(updated as CreatorWorld, online(id)))
      return
    }

    if (!isMap && method === 'DELETE') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const world = CREATOR_WORLD_ID.test(id) ? await opts.store.get(id) : null
      if (!world || (world.ownerSubject !== user.subjectId && !isGamesStaff(user)))
        return fail(404, 'world_not_found')
      const byStaff = world.ownerSubject !== user.subjectId
      const events = opts.events?.sink.enabled ? opts.events : null
      await opts.host.remove(
        id,
        events
          ? async (t) => {
              await opts.search?.remove(t, id)
              if (byStaff)
                await events.sink.enqueue(
                  t,
                  moderationEvent(
                    'world.deleted',
                    { type: 'world', id, ownerSubject: world.ownerSubject },
                    actorFor(user.subjectId),
                    { details: { status: world.status } },
                  ),
                )
            }
          : undefined,
      )
      opts.log.info('creator world deleted', {
        world: id,
        staff: world.ownerSubject !== user.subjectId,
      })
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }

    fail(405, 'method_not_allowed')
  }

  /** true when the request was /api/worlds… (answered, or being answered). */
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? '/', 'http://games.local')
    if (url.pathname !== '/api/worlds' && !url.pathname.startsWith('/api/worlds/')) return false
    route(req, res, url).catch((err: unknown) => {
      if (res.headersSent) return
      if (err instanceof RouteError) {
        const { status, ...body } = err.problem
        send(res, status, body)
        return
      }
      opts.log.warn('worlds request failed', {
        error: String((err as Error | undefined)?.message ?? err),
      })
      send(res, 500, { error: 'internal' })
    })
    return true
  }
}

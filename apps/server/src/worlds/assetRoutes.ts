import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CREATOR_ASSET_ID,
  CREATOR_ASSET_LIMITS,
  CREATOR_SCRIPT_LIMITS,
  CREATOR_WORLD_ID,
  creatorAssetOf,
  prefabCounts,
  type PrefabBody,
  type ScriptMod,
} from '@openvibe/content'
import type {
  CreatorAsset,
  CreatorAssetKind,
  CreatorAssetStatus,
  CreatorAssetStore,
  CreatorWorldStore,
} from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import type { Db } from 'openvibe-sdk/db'
import { actorFor, moderationEvent, type EventSink } from '../platform/gameEvents.js'
import type { GamesActorLimits } from '../net/actorLimits.js'
import type { NetworkUser } from '../net/networkAuth.js'
import {
  RouteError,
  cleanText,
  fail,
  isGamesStaff,
  isStaff,
  parseJson,
  readBody,
} from './worldRoutes.js'

/**
 * /api/assets: the asset store (migration 0016; docs/platform-direction.md step 5, free first). Builds (pieces placed
 * in the editor) and scripts (one games-quickjs@1 mod) that a signed-in creator publishes for anyone to use in their
 * own worlds. Anyone reads the store; using an asset counts once per person; staff hide one.
 *
 *   GET    /api/assets[?kind=prefab|script&page=]   published assets, newest first (no bodies)
 *   GET    /api/assets/mine                         the caller's assets
 *   POST   /api/assets  { kind, title, summary?, body, from_world? }   publish (from_world: a world you build, credited)
 *   GET    /api/assets/:id                          one asset with its body (published, or yours, or staff)
 *   POST   /api/assets/:id/use                      its body, and the caller's use counted once
 *   PATCH  /api/assets/:id  { title?, summary?, status? }   owner: title, summary; staff: hidden|published
 *   DELETE /api/assets/:id                          the owner or games staff
 */

export interface AssetRouteOptions {
  store: CreatorAssetStore
  /** To credit the world a build or script came from (one the caller builds). */
  worlds: CreatorWorldStore
  resolveUser: (token: string) => Promise<NetworkUser | null>
  limits: GamesActorLimits
  address: (req: IncomingMessage) => string
  log: Logger
  perPerson: number
  /** games.moderation.action when staff hide or restore someone else's asset, in the same transaction. */
  events?: { db: Db; sink: EventSink }
  now?: () => number
}

const PAGE_SIZE = 24
const META_BYTES = 16 * 1024
const TITLE_MAX = 60
const SUMMARY_MAX = 280

/** What a card shows: a build's pieces, or a script's hooks and what it may do. */
function contents(asset: CreatorAsset) {
  if (asset.kind === 'prefab') return prefabCounts(asset.body as PrefabBody)
  const mod = asset.body as ScriptMod
  return { hooks: mod.hooks ?? [], capabilities: mod.capabilities ?? [] }
}

function publicView(asset: CreatorAsset) {
  return {
    id: asset.id,
    kind: asset.kind,
    title: asset.title,
    summary: asset.summary,
    owner: asset.ownerName,
    uses: asset.uses,
    contents: contents(asset),
    from_world: asset.fromWorld
      ? {
          id: asset.fromWorld.id,
          title: asset.fromWorld.title,
          url: `/worlds/${asset.fromWorld.id}`,
        }
      : null,
    created_at: new Date(asset.createdAt).toISOString(),
    updated_at: new Date(asset.updatedAt).toISOString(),
  }
}

function ownerView(asset: CreatorAsset) {
  return { ...publicView(asset), status: asset.status }
}

export function createAssetRoutes(opts: AssetRouteOptions) {
  const now = opts.now ?? Date.now

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  const caller = async (req: IncomingMessage): Promise<NetworkUser | null> => {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null
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

  /** An asset the caller may see: published, or theirs, or staff. Anything else is not found. */
  const visible = async (id: string, user: NetworkUser | null): Promise<CreatorAsset> => {
    const asset = CREATOR_ASSET_ID.test(id) ? await opts.store.get(id) : null
    if (!asset) return fail(404, 'asset_not_found')
    if (asset.status === 'published' || isStaff(user) || asset.ownerSubject === user?.subjectId)
      return asset
    return fail(404, 'asset_not_found')
  }

  const publicRead = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> =>
    opts.limits.publicRead(req, res, `ip:${opts.address(req)}`)

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/api/assets' && method === 'GET') {
      if (!(await publicRead(req, res))) return
      const page = Number(url.searchParams.get('page') ?? '1')
      const kind = url.searchParams.get('kind')
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) fail(400, 'invalid_query')
      if (kind !== null && kind !== 'prefab' && kind !== 'script') fail(400, 'invalid_query')
      const rows = await opts.store.listPublished(
        kind as CreatorAssetKind | null,
        PAGE_SIZE + 1,
        (page - 1) * PAGE_SIZE,
      )
      send(res, 200, {
        assets: rows.slice(0, PAGE_SIZE).map(publicView),
        page,
        more: rows.length > PAGE_SIZE,
      })
      return
    }

    if (path === '/api/assets/mine' && method === 'GET') {
      const user = await signedIn(req)
      const assets = await opts.store.listByOwner(user.subjectId)
      send(res, 200, {
        assets: assets.map(ownerView),
        max: opts.perPerson,
        limits: { build: CREATOR_ASSET_LIMITS, script: CREATOR_SCRIPT_LIMITS },
        staff: isStaff(user),
      })
      return
    }

    if (path === '/api/assets' && method === 'POST') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const raw = parseJson(
        (await readBody(req, CREATOR_ASSET_LIMITS.bytes + CREATOR_SCRIPT_LIMITS.bytes + META_BYTES))
          .text,
      ) as Record<string, unknown> | null
      const title = cleanText(raw?.title, TITLE_MAX)
      const summary = raw?.summary === undefined ? '' : cleanText(raw.summary, SUMMARY_MAX)
      if (!title) fail(422, 'invalid_title', { detail: `A title of 1 to ${TITLE_MAX} characters.` })
      if (summary === null)
        fail(422, 'invalid_summary', { detail: `At most ${SUMMARY_MAX} characters.` })
      const checked = creatorAssetOf(raw?.kind, raw?.body)
      if (!checked.kind || !checked.body)
        fail(422, 'asset_invalid', { issues: checked.issues.slice(0, 40) })
      // A credit names a world the caller builds (theirs or their team's), as it is now.
      let fromWorld: { id: string; title: string } | null = null
      if (raw?.from_world !== undefined && raw.from_world !== null) {
        const wid = String(raw.from_world)
        const world = CREATOR_WORLD_ID.test(wid) ? await opts.worlds.get(wid) : null
        const builds =
          !!world &&
          (world.ownerSubject === user.subjectId ||
            (await opts.worlds.isMember(world.id, user.subjectId)))
        if (!world || !builds)
          fail(422, 'invalid_world', { detail: 'Name one of the worlds you build.' })
        fromWorld = { id: (world as { id: string }).id, title: (world as { title: string }).title }
      }
      if ((await opts.store.countByOwner(user.subjectId)) >= opts.perPerson)
        fail(409, 'asset_limit', {
          detail: `You can keep ${opts.perPerson} assets in the store. Delete one to publish another.`,
        })
      const asset = await opts.store.create({
        ownerSubject: user.subjectId,
        ownerName: user.name,
        kind: checked.kind as CreatorAssetKind,
        title: title as string,
        summary: summary as string,
        body: checked.body,
        fromWorld,
        now: now(),
      })
      void opts.store.rename(user.subjectId, user.name).catch(() => undefined)
      opts.log.info('creator asset published', { asset: asset.id, kind: asset.kind })
      send(res, 201, { ...ownerView(asset), body: asset.body })
      return
    }

    const match = /^\/api\/assets\/([^/]+)(\/use)?$/.exec(path)
    if (!match) fail(404, 'not_found')
    const id = match?.[1] ?? ''
    const isUse = match?.[2] === '/use'

    if (isUse && method === 'POST') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const asset = await visible(id, user)
      // Its creator using it is not a use; anyone else counts once.
      if (asset.ownerSubject !== user.subjectId)
        await opts.store.countUse(asset.id, user.subjectId, now())
      const fresh = (await opts.store.get(asset.id)) ?? asset
      send(res, 200, { ...publicView(fresh), body: fresh.body })
      return
    }

    if (!isUse && method === 'GET') {
      const user = await caller(req)
      if (!user && !(await publicRead(req, res))) return
      const asset = await visible(id, user)
      const mine = user?.subjectId === asset.ownerSubject
      send(res, 200, {
        ...(mine || isStaff(user) ? ownerView(asset) : publicView(asset)),
        body: asset.body,
      })
      return
    }

    if (!isUse && method === 'PATCH') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const raw = parseJson((await readBody(req, META_BYTES)).text) as Record<
        string,
        unknown
      > | null
      const asset = CREATOR_ASSET_ID.test(id) ? await opts.store.get(id) : null
      const mine = !!asset && asset.ownerSubject === user.subjectId
      if (!asset || (!mine && !isStaff(user))) return fail(404, 'asset_not_found')
      const patch: { title?: string; summary?: string; status?: CreatorAssetStatus } = {}
      if (raw?.title !== undefined) {
        if (!mine) fail(403, 'owner_only')
        const title = cleanText(raw.title, TITLE_MAX)
        if (!title)
          fail(422, 'invalid_title', { detail: `A title of 1 to ${TITLE_MAX} characters.` })
        patch.title = title as string
      }
      if (raw?.summary !== undefined) {
        if (!mine) fail(403, 'owner_only')
        const summary = cleanText(raw.summary, SUMMARY_MAX)
        if (summary === null)
          fail(422, 'invalid_summary', { detail: `At most ${SUMMARY_MAX} characters.` })
        patch.summary = summary as string
      }
      if (raw?.status !== undefined) {
        // Staff take an asset down or put it back; its creator cannot bring back one staff took down.
        if (raw.status !== 'published' && raw.status !== 'hidden') fail(422, 'invalid_status')
        if (!isStaff(user)) fail(403, 'staff_only')
        patch.status = raw.status as CreatorAssetStatus
      }
      const events = opts.events?.sink.enabled ? opts.events : null
      const moderated = !mine && patch.status !== undefined && patch.status !== asset.status
      const apply = () => opts.store.update(id, patch, now())
      const updated =
        events && moderated
          ? await events.db.tx(async (t) => {
              const next = await apply()
              await events.sink.enqueue(
                t,
                moderationEvent(
                  patch.status === 'hidden' ? 'asset.hidden' : 'asset.restored',
                  { type: 'asset', id, ownerSubject: asset.ownerSubject },
                  actorFor(user.subjectId),
                  { details: { from: asset.status, to: patch.status, kind: asset.kind } },
                ),
              )
              return next
            })
          : await apply()
      if (!updated) fail(404, 'asset_not_found')
      if (moderated) opts.log.info('creator asset status', { asset: id, to: patch.status })
      send(res, 200, ownerView(updated as CreatorAsset))
      return
    }

    if (!isUse && method === 'DELETE') {
      const user = await signedIn(req)
      if (!(await opts.limits.worldWrite(req, res, `world:${user.subjectId}`))) return
      const asset = CREATOR_ASSET_ID.test(id) ? await opts.store.get(id) : null
      if (!asset || (asset.ownerSubject !== user.subjectId && !isGamesStaff(user)))
        return fail(404, 'asset_not_found')
      const byStaff = asset.ownerSubject !== user.subjectId
      const events = opts.events?.sink.enabled ? opts.events : null
      if (events && byStaff)
        await events.db.tx(async (t) => {
          await opts.store.remove(id)
          await events.sink.enqueue(
            t,
            moderationEvent(
              'asset.deleted',
              { type: 'asset', id, ownerSubject: asset.ownerSubject },
              actorFor(user.subjectId),
              { details: { kind: asset.kind } },
            ),
          )
        })
      else await opts.store.remove(id)
      opts.log.info('creator asset deleted', { asset: id, staff: byStaff })
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }

    fail(405, 'method_not_allowed')
  }

  /** true when the request was /api/assets… (answered, or being answered). */
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? '/', 'http://games.local')
    if (url.pathname !== '/api/assets' && !url.pathname.startsWith('/api/assets/')) return false
    route(req, res, url).catch((err: unknown) => {
      if (res.headersSent) return
      if (err instanceof RouteError) {
        const { status, ...body } = err.problem
        send(res, status, body)
        return
      }
      opts.log.warn('assets request failed', {
        error: String((err as Error | undefined)?.message ?? err),
      })
      send(res, 500, { error: 'internal' })
    })
    return true
  }
}

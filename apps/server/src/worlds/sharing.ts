import { createRequire } from 'node:module'
import type { IncomingMessage } from 'node:http'
import type { Db, Tx } from 'openvibe-sdk/db'
import type { Role, Shares, ShareOptions, ResourceRef } from 'openvibe-sdk/share'
import type { SubjectRef } from 'openvibe-sdk/core'
import type { CreatorWorld, CreatorWorldStore } from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import type { NetworkUser } from '../net/networkAuth.js'
import { viewerAccountKey } from '../net/viewer.js'

/**
 * Sharing for creator worlds (design 2026-11-06, VISIBILITY-EVERYWHERE step 5; openvibe-sdk/share).
 *
 * A draft is Only me. Its Share sheet can name people (`people`) so friends can open its page and join
 * and play it before it is published; publishing widens it to Everyone, and the public list, the
 * sitemap and Search still show published worlds only. The `shares` row is the access authority for
 * every world read path (the API, /worlds/<id>, the join), with `status = 'published'` as the public
 * fact the gathered pages keep using.
 */
const req = createRequire(import.meta.url)
type ShareModule = {
  createShares(options: ShareOptions): Shares
}
const { createShares } = req('openvibe-sdk/share') as ShareModule

const SERVICE = 'games'
const KIND = 'world'
const AUDIENCES = ['public', 'link', 'people', 'private'] as const

export interface WorldSharingOptions {
  db: Db
  store: CreatorWorldStore
  network: { json(options: { service: string; audience: string; path: string; method?: string; json?: unknown; query?: Record<string, string> }): Promise<unknown> }
  events: { publish(event: unknown): Promise<unknown> }
  notify(notification: Record<string, unknown>): Promise<unknown>
  log: Logger
  publicUrl?: string
}

export interface WorldSharing {
  shares: Shares
  service: string
  kind: string
  /** The SDK viewer for a Games account, or null. */
  viewer(user: NetworkUser | null): { subject: { type: 'user'; id: string }; staff: boolean } | null
  canView(user: NetworkUser | null, id: string): Promise<boolean>
  canEdit(user: NetworkUser | null, id: string): Promise<boolean>
  /** The world's audience: its share row, else published → public and draft/hidden → private. */
  audienceOf(world: CreatorWorld | null): Promise<'public' | 'link' | 'people' | 'private'>
  /** Register a world that has no share row yet (a legacy world, or one created before its sheet opened). */
  ensure(id: string): Promise<void>
  /** A new world starts Only me; publishing through the owner's PATCH widens it to the status's audience. */
  register(world: CreatorWorld): Promise<void>
  syncFromStatus(id: string, status: string): Promise<void>
  /** The viewer's account key (usr_… or guest:…), as the page resolver returns it. */
  viewerFromRequest(req: IncomingMessage, networkAuthUrl: string | null): Promise<{ subject: { type: 'user'; id: string }; staff: boolean } | null>
  work(): Promise<{ expired: number; sent: number }>
}

const subjectOf = (value: string | null | undefined) =>
  value && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(value) ? { type: 'user' as const, id: value } : null

export function createWorldSharing(opts: WorldSharingOptions): WorldSharing {
  const { db, store, log } = opts
  const audiences: string[] = [...AUDIENCES]

  const shares = createShares({
    db,
    network: opts.network,
    events: opts.events,
    notify: opts.notify,
    async onOwnerChange(ref: ResourceRef, _from: SubjectRef, to: SubjectRef, tx: Tx) {
      if (ref.service !== SERVICE || ref.kind !== KIND || to?.type !== 'user') return
      await tx.exec('UPDATE creator_worlds SET owner_subject = $1 WHERE id = $2', [to.id, ref.id])
    },
  } as unknown as ShareOptions)

  const viewer = (user: NetworkUser | null) => {
    const subject = subjectOf(user?.subjectId ?? null)
    if (!subject) return null
    return { subject, staff: user?.rank === 'owner' || user?.rank === 'admin' }
  }

  const refOf = (id: string) => ({ service: SERVICE, kind: KIND, id: String(id) })

  async function shareOf(id: string): Promise<{ audience: string } | null> {
    return await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(id)])
  }

  async function audienceOf(world: CreatorWorld | null): Promise<'public' | 'link' | 'people' | 'private'> {
    if (!world) return 'private'
    const row = await shareOf(world.id)
    if (row && audiences.includes(row.audience)) return row.audience as 'public' | 'link' | 'people' | 'private'
    return world.status === 'published' ? 'public' : 'private'
  }

  async function ensure(id: string): Promise<void> {
    if (await shareOf(id)) return
    const world = await store.get(id)
    if (!world) return
    await register(world)
  }

  async function register(world: CreatorWorld): Promise<void> {
    const owner = subjectOf(world.ownerSubject) || { type: 'service' as const, id: SERVICE }
    try {
      await shares.register(refOf(world.id), { owner_subject: owner, audience: world.status === 'published' ? 'public' : 'private' })
    } catch (err) {
      if ((err as { status?: number }).status !== 409) throw err   // somebody registered it first: use theirs
    }
  }

  /**
   * Publishing through the owner's PATCH widens the world to Everyone; unpublishing narrows it to Only me.
   * It goes through the SDK as the owner, so the change is logged and announced like one made in the sheet.
   */
  async function syncFromStatus(id: string, status: string): Promise<void> {
    const next = status === 'published' ? 'public' : 'private'
    const world = await store.get(id)
    const owner = subjectOf(world?.ownerSubject ?? null)
    if (!owner) return
    await ensure(id)
    const current = await shareOf(id)
    if (!current || current.audience === next) return
    await shares.setAudience({ subject: owner, staff: false }, refOf(id), next)
  }

  return {
    shares,
    service: SERVICE,
    kind: KIND,
    viewer,
    canView: async (user, id) => await shares.canView(viewer(user), refOf(id)),
    canEdit: async (user, id) => await shares.canEdit(viewer(user), refOf(id)),
    audienceOf,
    ensure,
    register,
    syncFromStatus,
    async viewerFromRequest(request, networkAuthUrl) {
      const key = await viewerAccountKey(request, { networkAuthUrl }).catch(() => null)
      const subject = subjectOf(key)
      return subject ? { subject, staff: false } : null
    },
    async work() {
      let expired = 0
      try { expired = await shares.expireMembers() } catch (err) { log.warn('sharing expiry sweep failed', { error: String((err as Error | undefined)?.message ?? err) }) }
      let sent = 0
      try { sent = await shares.flush() } catch (err) { log.warn('sharing deliveries failed', { error: String((err as Error | undefined)?.message ?? err) }) }
      return { expired, sent }
    },
  }
}

/** The uniform API's describe(ref): the sheet shows the world's title and page to its owner. */
export function describeWorldRef(store: CreatorWorldStore, publicUrl: string) {
  return async (ref: { service: string; kind: string; id: string }) => {
    if (ref.service !== SERVICE || ref.kind !== KIND) return {}
    const world = await store.get(ref.id)
    if (!world) return {}
    return {
      title: world.title,
      link: `${publicUrl.replace(/\/+$/, '')}/worlds/${world.id}`,
      roles: ['viewer'] as Role[],
      audiences: [...AUDIENCES],
      transferable: false,
      world: { status: world.status, revision: world.revision },
    }
  }
}

/** The signed-in Games account a share request names (bearer first, then the ovg_sso cookie). */
export async function shareUser(req: IncomingMessage, resolveUser: (token: string) => Promise<NetworkUser | null>): Promise<NetworkUser | null> {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  const cookie = /(?:^|;\s*)ovg_sso=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
  const token = bearer ?? (cookie ? decodeURIComponent(cookie) : null)
  if (!token) return null
  return await resolveUser(token).catch(() => null)
}

/**
 * The mod registry (ADR-013, roadmap Wave 12): installs, the approved subset
 * of each install's requested capabilities, lifecycle and the audit log, all
 * in Games' own PostgreSQL database.
 *
 *   install   validate the manifest + pack, store it, grant the approved subset
 *   enable / disable
 *   grant / revokeGrant   change one capability of an install
 *   revoke    terminal: every grant ends and the runtime retracts the mod's
 *             effects on the next tick
 *
 * Every change is one database transaction holding the registry rows, the audit rows and the
 * `games.mod.*` outbox event. The in-memory view the runtime asks on its hot path (`isGranted`, and the
 * placements mirror) is refreshed only after that commit.
 *
 * The tick never awaits I/O: `audit`, `place` and `unplace` are called from the mod runtime on the tick
 * and go through a serialized write queue (the placements mirror updates immediately, the database write
 * commits asynchronously); a failure is logged and counted, never thrown into the tick. Everything the
 * HTTP API and Network events call is explicit and awaited.
 *
 * Trust tiers are metadata: `isGranted` never looks at them.
 *
 * ADR-013 puts grants in OpenVibe.Network (a `mod` principal per install,
 * roadmap WS-M task 3): with a platform client, the mods API asks Network
 * first (./networkGrants.ts) and applies only what Network answered, and
 * `applyNetwork` makes this copy follow network.mod.grants_changed (a change
 * staff made in Network). The approved subset here is the hot path's copy.
 */
import type { ContentRegistry } from '@openvibe/content'
import type {
  ModAuditDto,
  ModGrantDto,
  ModInstallDto,
  ModPlacementDto,
  ModStatus,
  ModTrustTier,
  PersistenceStore,
} from '@openvibe/persistence'
import type { SubjectRef } from 'openvibe-sdk/core'
import type { Tx } from 'openvibe-sdk/db'
import {
  moderationEvent,
  modEvent,
  NO_EVENTS,
  type EventSink,
  type ModLifecycle,
} from '../platform/gameEvents.js'
import {
  capabilitiesUsedBy,
  CONTENT_RUNTIME_CAPABILITIES,
  validateContentPack,
  type ContentPack,
} from './contentPack.js'
import { checkForGames, validateManifest, type ModManifest } from './manifest.js'

export const TRUST_TIERS: readonly ModTrustTier[] = ['unreviewed', 'reviewed', 'first-party']

/** Who performed a registry change: an audit string and an event actor. */
export interface ModActor {
  /** `usr_…`, a Network user id, or `svc:<client>`. */
  audit: string
  subject: SubjectRef
}

export const SYSTEM_ACTOR: ModActor = { audit: 'games', subject: { type: 'service', id: 'games' } }
/** Changes that come from OpenVibe.Network's mod principal (network.mod.grants_changed). */
export const NETWORK_ACTOR: ModActor = {
  audit: 'network',
  subject: { type: 'service', id: 'network' },
}

export class ModError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly errors: string[] = [],
  ) {
    super(message)
  }
}

export interface InstallRequest {
  manifest: unknown
  pack: unknown
  /** The approved subset of manifest.permissions.capabilities. */
  approve?: unknown
  trustTier?: unknown
  enable?: unknown
}

/** A mod as the runtime and the API see it. */
export interface ModView {
  mod: ModInstallDto
  manifest: ModManifest
  pack: ContentPack
  /** Capabilities currently granted (approved and not revoked). */
  granted: ReadonlySet<string>
}

export class ModRegistry {
  private readonly views = new Map<string, ModView>()
  /** In-memory mirror of each install's placements the runtime reads on the tick. */
  private readonly placementsByMod = new Map<string, ModPlacementDto[]>()
  /** The Network principal revision each install's grants were last set from (an older event changes nothing). */
  private readonly networkRevision = new Map<string, number>()
  /** Serialized writes the tick path (and only it) fires without awaiting. */
  private writeChain: Promise<void> = Promise.resolve()
  private revision = 0
  /** Writes the tick path queued that failed; the runtime keeps running. */
  writeFailures = 0

  constructor(
    private readonly store: PersistenceStore,
    private readonly content: ContentRegistry,
    private readonly events: EventSink = NO_EVENTS,
    private readonly now: () => number = Date.now,
    private readonly log: { warn(msg: string, meta?: unknown): void } = {
      warn: (msg, meta) => console.warn(msg, meta),
    },
  ) {}

  /** Async boot: read every install, its grants and its placements into the in-memory mirrors. */
  async load(): Promise<void> {
    for (const mod of await this.store.mods.list()) await this.refresh(mod.id)
    for (const view of this.views.values()) {
      this.placementsByMod.set(view.mod.id, await this.store.mods.placements(view.mod.id))
    }
  }

  /** Bumps on every committed change; the runtime reconciles when it moves. */
  get version(): number {
    return this.revision
  }

  list(): ModView[] {
    return [...this.views.values()]
  }

  get(id: string): ModView | null {
    return this.views.get(id) ?? null
  }

  isActive(id: string): boolean {
    return this.views.get(id)?.mod.status === 'enabled'
  }

  /** The in-memory placements mirror (the tick reads this, never the database). */
  placements(modId: string): ModPlacementDto[] {
    return this.placementsByMod.get(modId) ?? []
  }

  /**
   * The one grant check. True only while the install is enabled and the
   * capability is in its approved, unrevoked subset. The trust tier is not
   * consulted — a tier label never grants anything.
   */
  isGranted(id: string, capability: string): boolean {
    const view = this.views.get(id)
    return view !== undefined && view.mod.status === 'enabled' && view.granted.has(capability)
  }

  auditLog(id: string, limit = 100): Promise<ModAuditDto[]> {
    return this.store.mods.auditLog(id, Math.min(Math.max(limit, 1), 500))
  }

  /**
   * Appends a runtime audit record (use, deny, retract, …). Called from the tick: the write is queued,
   * not awaited, and the placements/audit queue is one at a time so ordering is kept.
   */
  audit(
    id: string,
    action: string,
    capability: string | null,
    detail?: Record<string, unknown>,
  ): void {
    this.enqueueWrite(async () => {
      await this.store.mods.audit({
        modId: id,
        action,
        capability,
        actor: SYSTEM_ACTOR.audit,
        detail: detail ?? null,
        at: this.now(),
      })
    })
  }

  /** Records (or re-records) a placement in the mirror and queue-writes it. Called from the tick. */
  place(modId: string, key: string, entityId: string | null): void {
    const at = this.now()
    const before = (this.placementsByMod.get(modId) ?? []).filter((p) => p.key === key)
    const list = (this.placementsByMod.get(modId) ?? []).filter((p) => p.key !== key)
    list.push({ modId, key, entityId, at })
    this.placementsByMod.set(modId, list)
    this.enqueueWrite(
      async () => {
        await this.store.mods.setPlacement({ modId, key, entityId, at })
      },
      () => this.rollbackPlacement(modId, key, at, before),
    )
  }

  /** Removes a placement from the mirror and queue-writes the delete. Called from the tick. */
  unplace(modId: string, key: string): void {
    const before = (this.placementsByMod.get(modId) ?? []).filter((p) => p.key === key)
    const list = (this.placementsByMod.get(modId) ?? []).filter((p) => p.key !== key)
    this.placementsByMod.set(modId, list)
    this.enqueueWrite(
      async () => {
        await this.store.mods.deletePlacement(modId, key)
      },
      () => this.rollbackPlacement(modId, key, null, before),
    )
  }

  /**
   * The queued write never landed: put the mirror back so it agrees with the database. Only undoes the
   * change when the mirror still holds it (`stamp` is what this call set, or null for a removal), so a
   * later place/unplace of the same key is left to its own write.
   */
  private rollbackPlacement(
    modId: string,
    key: string,
    stamp: number | null,
    before: ModPlacementDto[],
  ): void {
    const current = this.placementsByMod.get(modId) ?? []
    const entry = current.find((p) => p.key === key)
    if ((entry?.at ?? null) !== stamp) return
    const rest = current.filter((p) => p.key !== key)
    this.placementsByMod.set(modId, [...rest, ...before])
    this.log.warn('mod placement write failed: mirror rolled back', { mod: modId, key })
  }

  /** One serialized write queue for the tick path; failures are retried, then logged and counted, never thrown. */
  private enqueueWrite(write: () => Promise<void>, onGiveUp?: () => void): void {
    this.writeChain = this.writeChain.then(async () => {
      const delaysMs = [25, 100]
      for (let attempt = 0; ; attempt++) {
        try {
          await write()
          return
        } catch (err: unknown) {
          if (attempt < delaysMs.length) {
            await new Promise((r) => setTimeout(r, delaysMs[attempt]))
            continue
          }
          this.writeFailures++
          onGiveUp?.()
          this.log.warn('mod write failed', {
            error: String((err as Error | undefined)?.message ?? err),
          })
          return
        }
      }
    })
  }

  /** Waits for queued tick-path writes (shutdown/tests). */
  async flushWrites(): Promise<void> {
    await this.writeChain
  }

  /** Everything install checks before it writes: the manifest, the pack, the approved subset and the options. */
  async checkInstall(req: InstallRequest): Promise<{
    manifest: ModManifest
    pack: ContentPack
    approve: string[]
    trustTier: ModTrustTier
    enable: boolean
  }> {
    const manifestCheck = validateManifest(req.manifest)
    if (!manifestCheck.ok) {
      throw new ModError('mod.manifest_invalid', 'manifest is invalid', 422, manifestCheck.errors)
    }
    const manifest = manifestCheck.value
    const runtimeErrors = checkForGames(manifest)
    if (runtimeErrors.length > 0) {
      throw new ModError('mod.runtime_unsupported', 'manifest cannot run here', 422, runtimeErrors)
    }
    const packCheck = validateContentPack(req.pack ?? {}, this.content)
    if (!packCheck.ok) {
      throw new ModError('mod.pack_invalid', 'content pack is invalid', 422, packCheck.errors)
    }
    const pack = packCheck.value
    const requested = new Set(manifest.permissions.capabilities)
    const unrequested = capabilitiesUsedBy(pack).filter((c) => !requested.has(c))
    if (unrequested.length > 0) {
      throw new ModError(
        'mod.pack_invalid',
        'the pack uses capabilities the manifest does not request',
        422,
        unrequested.map((c) => `pack needs ${c}`),
      )
    }
    const approve = parseCapabilityList(req.approve ?? [])
    for (const cap of approve) this.assertGrantable(manifest, cap)
    const trustTier = parseTrustTier(req.trustTier ?? 'unreviewed')
    const enable = req.enable === true
    if (this.views.has(manifest.id) || (await this.store.mods.get(manifest.id))) {
      throw new ModError('mod.exists', `mod ${manifest.id} is already installed`, 409)
    }
    return { manifest, pack, approve, trustTier, enable }
  }

  async install(req: InstallRequest, actor: ModActor): Promise<ModView> {
    const { manifest, pack, approve, trustTier, enable } = await this.checkInstall(req)
    const requested = new Set(manifest.permissions.capabilities)
    const at = this.now()
    const mod: ModInstallDto = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      target: manifest.target,
      runtime: manifest.runtime,
      manifest: manifest as unknown as Record<string, unknown>,
      pack: pack as unknown as Record<string, unknown>,
      trustTier,
      status: enable ? 'enabled' : 'disabled',
      installedBy: actor.audit,
      installedAt: at,
      updatedAt: at,
    }
    await this.store.transaction(async (t) => {
      await this.store.mods.insert(mod)
      await this.writeAudit(mod.id, 'install', null, actor, {
        version: mod.version,
        runtime: mod.runtime,
        trust_tier: trustTier,
        requested: [...requested].sort(),
      })
      for (const cap of approve) {
        await this.store.mods.upsertGrant(grantRow(mod.id, cap, actor, at))
        await this.writeAudit(mod.id, 'grant', cap, actor, null)
      }
      if (enable) await this.writeAudit(mod.id, 'enable', null, actor, null)
      await this.emit(t, 'installed', mod, actor, {
        requested: [...requested].sort(),
        granted: [...approve].sort(),
        status: mod.status,
      })
    })
    return this.refresh(mod.id)
  }

  enable(id: string, actor: ModActor): Promise<ModView> {
    return this.setStatus(id, 'enabled', actor)
  }

  disable(id: string, actor: ModActor): Promise<ModView> {
    return this.setStatus(id, 'disabled', actor)
  }

  /** Ends the install for good: every grant is revoked and the mod stops at the next tick. */
  async revoke(id: string, actor: ModActor, reason?: string): Promise<ModView> {
    const view = this.require(id)
    if (view.mod.status === 'revoked') return view
    const at = this.now()
    await this.store.transaction(async (t) => {
      for (const cap of view.granted) {
        await this.store.mods.revokeGrant(id, cap, actor.audit, at)
        await this.writeAudit(id, 'revoke_grant', cap, actor, null)
      }
      await this.store.mods.setStatus(id, 'revoked', at)
      await this.writeAudit(id, 'revoke', null, actor, reason ? { reason } : null)
      await this.emit(t, 'revoked', { ...view.mod, status: 'revoked' }, actor, {
        revoked_grants: [...view.granted].sort(),
        ...(reason ? { reason } : {}),
      })
      await this.moderated(t, 'mod.revoked', view, actor, reason, {
        previous: view.mod.status,
        revoked_grants: [...view.granted].sort(),
      })
    })
    return this.refresh(id)
  }

  async grant(id: string, capability: string, actor: ModActor): Promise<ModView> {
    const view = this.require(id)
    if (view.mod.status === 'revoked') {
      throw new ModError('mod.revoked', 'a revoked install cannot be granted anything', 409)
    }
    this.assertGrantable(view.manifest, capability)
    if (view.granted.has(capability)) return view
    const at = this.now()
    await this.store.transaction(async (t) => {
      await this.store.mods.upsertGrant(grantRow(id, capability, actor, at))
      await this.writeAudit(id, 'grant', capability, actor, null)
      await this.emit(t, 'grants_changed', view.mod, actor, { granted: [capability], revoked: [] })
    })
    return this.refresh(id)
  }

  async revokeGrant(id: string, capability: string, actor: ModActor): Promise<ModView> {
    const view = this.require(id)
    const at = this.now()
    let changed = false
    await this.store.transaction(async (t) => {
      changed = await this.store.mods.revokeGrant(id, capability, actor.audit, at)
      if (!changed) return
      await this.writeAudit(id, 'revoke_grant', capability, actor, null)
      await this.emit(t, 'grants_changed', view.mod, actor, { granted: [], revoked: [capability] })
    })
    return changed ? this.refresh(id) : view
  }

  /** The Network revision the API just applied (install, grant, revoke), so a late older event is ignored. */
  noteNetworkRevision(id: string, revision: number): void {
    if (revision > (this.networkRevision.get(id) ?? 0)) this.networkRevision.set(id, revision)
  }

  /** What grant checks before it writes (the Network call comes between). */
  async checkGrant(id: string, capability: string): Promise<void> {
    const view = this.require(id)
    if (view.mod.status === 'revoked') {
      throw new ModError('mod.revoked', 'a revoked install cannot be granted anything', 409)
    }
    this.assertGrantable(view.manifest, capability)
  }

  /**
   * Make this copy match the install's principal in Network (network.mod.grants_changed, or a read at boot):
   * a revoked principal revokes the install; otherwise capabilities Network does not approve are revoked here and
   * approved ones this runtime can bind are granted. Unknown installs are ignored. Returns the view, or null.
   */
  async applyNetwork(
    principal: { mod_id: string; status: string; approved: readonly string[]; revision?: number },
    actor: ModActor = NETWORK_ACTOR,
  ): Promise<ModView | null> {
    const view = this.views.get(principal.mod_id)
    if (!view) return null
    // Events can arrive after the API already applied a newer answer: an older (or equal) revision changes
    // nothing. The revision is remembered only once the writes below succeed, so a failed write leaves the
    // answer eligible for redelivery instead of being dropped as stale.
    if (
      principal.revision !== undefined &&
      principal.revision <= (this.networkRevision.get(view.mod.id) ?? 0)
    )
      return view
    const revision = principal.revision
    const applied = (outcome: ModView): ModView => {
      if (revision !== undefined) this.noteNetworkRevision(view.mod.id, revision)
      return outcome
    }
    if (principal.status === 'revoked')
      return applied(await this.revoke(view.mod.id, actor, 'revoked in OpenVibe.Network'))
    if (view.mod.status === 'revoked') return applied(view)
    const approved = new Set(principal.approved)
    let current = view
    for (const cap of [...current.granted])
      if (!approved.has(cap)) current = await this.revokeGrant(view.mod.id, cap, actor)
    for (const cap of approved) {
      if (current.granted.has(cap)) continue
      try {
        this.assertGrantable(current.manifest, cap)
      } catch {
        continue
      }
      current = await this.grant(view.mod.id, cap, actor)
    }
    return applied(current)
  }

  private async setStatus(id: string, status: ModStatus, actor: ModActor): Promise<ModView> {
    const view = this.require(id)
    if (view.mod.status === 'revoked') {
      throw new ModError('mod.revoked', 'a revoked install stays revoked; install a new one', 409)
    }
    if (view.mod.status === status) return view
    const at = this.now()
    await this.store.transaction(async (t) => {
      // Enabling puts a mod back only when someone disabled it before (a first enable is not moderation).
      const restoring =
        status === 'enabled' &&
        (await this.store.mods.auditLog(id, 10_000)).some(
          (a: ModAuditDto) => a.action === 'disable',
        )
      await this.store.mods.setStatus(id, status, at)
      const action = status === 'enabled' ? 'enable' : 'disable'
      await this.writeAudit(id, action, null, actor, null)
      await this.emit(t, status === 'enabled' ? 'enabled' : 'disabled', view.mod, actor, {})
      if (status === 'disabled' || restoring) {
        await this.moderated(t, `mod.${status}`, view, actor, undefined, {
          previous: view.mod.status,
        })
      }
    })
    return this.refresh(id)
  }

  private assertGrantable(manifest: ModManifest, capability: string): void {
    if (!manifest.permissions.capabilities.includes(capability)) {
      throw new ModError('mod.grant_not_requested', `${capability} was not requested`, 422)
    }
    if (!CONTENT_RUNTIME_CAPABILITIES.includes(capability)) {
      throw new ModError(
        'mod.grant_unsupported',
        `${capability} has no binding in ${manifest.runtime}`,
        422,
      )
    }
  }

  private require(id: string): ModView {
    const view = this.views.get(id)
    if (!view) throw new ModError('mod.not_found', `no mod ${id}`, 404)
    return view
  }

  private async writeAudit(
    id: string,
    action: string,
    capability: string | null,
    actor: ModActor,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    await this.store.mods.audit({
      modId: id,
      action,
      capability,
      actor: actor.audit,
      detail,
      at: this.now(),
    })
  }

  /** games.moderation.action, unless the publisher is acting on their own mod. */
  private async moderated(
    t: Tx,
    action: string,
    view: ModView,
    actor: ModActor,
    reason: string | undefined,
    details: Record<string, unknown>,
  ): Promise<void> {
    const publisher = view.manifest.publisher
    const owner = publisher && publisher.type === 'user' ? publisher.id : null
    if (owner && actor.subject.type === 'user' && actor.subject.id === owner) return
    await this.events.enqueue(
      t,
      moderationEvent(
        action,
        { type: 'mod', id: view.mod.id, ownerSubject: owner },
        actor.subject,
        {
          reason: reason ?? null,
          details,
        },
      ),
    )
  }

  private async emit(
    t: Tx,
    kind: ModLifecycle,
    mod: ModInstallDto,
    actor: ModActor,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.events.enqueue(t, modEvent(kind, mod, actor.subject, detail))
  }

  /** Re-reads one install after a committed change. */
  private async refresh(id: string): Promise<ModView> {
    const mod = await this.store.mods.get(id)
    if (!mod) {
      this.views.delete(id)
      throw new ModError('mod.not_found', `no mod ${id}`, 404)
    }
    const granted = new Set(
      (await this.store.mods.grants(id))
        .filter((g: ModGrantDto) => g.revokedAt === null)
        .map((g) => g.capability),
    )
    const view: ModView = {
      mod,
      manifest: mod.manifest as unknown as ModManifest,
      pack: mod.pack as unknown as ContentPack,
      granted,
    }
    this.views.set(id, view)
    this.revision++
    return view
  }
}

function grantRow(modId: string, capability: string, actor: ModActor, at: number): ModGrantDto {
  return {
    modId,
    capability,
    grantedBy: actor.audit,
    grantedAt: at,
    revokedAt: null,
    revokedBy: null,
  }
}

function parseCapabilityList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string') || value.length > 64) {
    throw new ModError('mod.invalid_request', 'approve must be an array of capability ids', 400)
  }
  return [...new Set(value as string[])]
}

function parseTrustTier(value: unknown): ModTrustTier {
  if (typeof value === 'string' && (TRUST_TIERS as readonly string[]).includes(value)) {
    return value as ModTrustTier
  }
  throw new ModError(
    'mod.invalid_request',
    `trustTier must be one of ${TRUST_TIERS.join(', ')}`,
    400,
  )
}

/**
 * The mod registry (ADR-013, roadmap Wave 12): installs, the approved subset
 * of each install's requested capabilities, lifecycle and the audit log, all
 * in Games' own SQLite database.
 *
 *   install   validate the manifest + pack, store it, grant the approved subset
 *   enable / disable
 *   grant / revokeGrant   change one capability of an install
 *   revoke    terminal: every grant ends and the runtime retracts the mod's
 *             effects on the next tick
 *
 * Every change is one transaction holding the registry rows, the audit rows
 * and the `games.mod.*` outbox event. The in-memory view the runtime asks on
 * its hot path (`isGranted`) is refreshed only after that commit.
 *
 * Trust tiers are metadata: `isGranted` never looks at them.
 *
 * ADR-013 puts grants in OpenVibe.Network (a `mod` principal per install).
 * Until Network issues mod principals, the approved subset lives here; the
 * shape (install -> approved capability ids, revocable at once) is the same
 * so the source of truth can move without changing the runtime seam.
 */
import type { ContentRegistry } from '@openvibe/content'
import type {
  ModAuditDto,
  ModGrantDto,
  ModInstallDto,
  ModStatus,
  ModTrustTier,
  PersistenceStore,
} from '@openvibe/persistence'
import type { SubjectRef } from 'openvibe-sdk/core'
import { modEvent, NO_EVENTS, type EventSink, type ModLifecycle } from '../platform/gameEvents.js'
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
  /** `usr_…`, `ovn:<id>` for a pre-subject staff token, or `svc:<client>`. */
  audit: string
  subject: SubjectRef
}

export const SYSTEM_ACTOR: ModActor = { audit: 'games', subject: { type: 'service', id: 'games' } }

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
  private revision = 0

  constructor(
    private readonly store: PersistenceStore,
    private readonly content: ContentRegistry,
    private readonly events: EventSink = NO_EVENTS,
    private readonly now: () => number = Date.now,
  ) {
    for (const mod of store.mods.list()) this.refresh(mod.id)
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

  /**
   * The one grant check. True only while the install is enabled and the
   * capability is in its approved, unrevoked subset. The trust tier is not
   * consulted — a tier label never grants anything.
   */
  isGranted(id: string, capability: string): boolean {
    const view = this.views.get(id)
    return view !== undefined && view.mod.status === 'enabled' && view.granted.has(capability)
  }

  auditLog(id: string, limit = 100): ModAuditDto[] {
    return this.store.mods.auditLog(id, Math.min(Math.max(limit, 1), 500))
  }

  /** Appends a runtime audit record (use, deny, retract, …). */
  audit(id: string, action: string, capability: string | null, detail?: Record<string, unknown>) {
    this.store.mods.audit({
      modId: id,
      action,
      capability,
      actor: SYSTEM_ACTOR.audit,
      detail: detail ?? null,
      at: this.now(),
    })
  }

  install(req: InstallRequest, actor: ModActor): ModView {
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
    if (this.views.has(manifest.id) || this.store.mods.get(manifest.id)) {
      throw new ModError('mod.exists', `mod ${manifest.id} is already installed`, 409)
    }

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
    this.store.transaction(() => {
      this.store.mods.insert(mod)
      this.writeAudit(mod.id, 'install', null, actor, {
        version: mod.version,
        runtime: mod.runtime,
        trust_tier: trustTier,
        requested: [...requested].sort(),
      })
      for (const cap of approve) {
        this.store.mods.upsertGrant(grantRow(mod.id, cap, actor, at))
        this.writeAudit(mod.id, 'grant', cap, actor, null)
      }
      if (enable) this.writeAudit(mod.id, 'enable', null, actor, null)
      this.emit('installed', mod, actor, {
        requested: [...requested].sort(),
        granted: [...approve].sort(),
        status: mod.status,
      })
    })
    return this.refresh(mod.id)
  }

  enable(id: string, actor: ModActor): ModView {
    return this.setStatus(id, 'enabled', actor)
  }

  disable(id: string, actor: ModActor): ModView {
    return this.setStatus(id, 'disabled', actor)
  }

  /** Ends the install for good: every grant is revoked and the mod stops at the next tick. */
  revoke(id: string, actor: ModActor, reason?: string): ModView {
    const view = this.require(id)
    if (view.mod.status === 'revoked') return view
    const at = this.now()
    this.store.transaction(() => {
      for (const cap of view.granted) {
        this.store.mods.revokeGrant(id, cap, actor.audit, at)
        this.writeAudit(id, 'revoke_grant', cap, actor, null)
      }
      this.store.mods.setStatus(id, 'revoked', at)
      this.writeAudit(id, 'revoke', null, actor, reason ? { reason } : null)
      this.emit('revoked', { ...view.mod, status: 'revoked' }, actor, {
        revoked_grants: [...view.granted].sort(),
        ...(reason ? { reason } : {}),
      })
    })
    return this.refresh(id)
  }

  grant(id: string, capability: string, actor: ModActor): ModView {
    const view = this.require(id)
    if (view.mod.status === 'revoked') {
      throw new ModError('mod.revoked', 'a revoked install cannot be granted anything', 409)
    }
    this.assertGrantable(view.manifest, capability)
    if (view.granted.has(capability)) return view
    const at = this.now()
    this.store.transaction(() => {
      this.store.mods.upsertGrant(grantRow(id, capability, actor, at))
      this.writeAudit(id, 'grant', capability, actor, null)
      this.emit('grants_changed', view.mod, actor, { granted: [capability], revoked: [] })
    })
    return this.refresh(id)
  }

  revokeGrant(id: string, capability: string, actor: ModActor): ModView {
    const view = this.require(id)
    const at = this.now()
    let changed = false
    this.store.transaction(() => {
      changed = this.store.mods.revokeGrant(id, capability, actor.audit, at)
      if (!changed) return
      this.writeAudit(id, 'revoke_grant', capability, actor, null)
      this.emit('grants_changed', view.mod, actor, { granted: [], revoked: [capability] })
    })
    return changed ? this.refresh(id) : view
  }

  private setStatus(id: string, status: ModStatus, actor: ModActor): ModView {
    const view = this.require(id)
    if (view.mod.status === 'revoked') {
      throw new ModError('mod.revoked', 'a revoked install stays revoked; install a new one', 409)
    }
    if (view.mod.status === status) return view
    const at = this.now()
    this.store.transaction(() => {
      this.store.mods.setStatus(id, status, at)
      const action = status === 'enabled' ? 'enable' : 'disable'
      this.writeAudit(id, action, null, actor, null)
      this.emit(status === 'enabled' ? 'enabled' : 'disabled', view.mod, actor, {})
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

  private writeAudit(
    id: string,
    action: string,
    capability: string | null,
    actor: ModActor,
    detail: Record<string, unknown> | null,
  ): void {
    this.store.mods.audit({
      modId: id,
      action,
      capability,
      actor: actor.audit,
      detail,
      at: this.now(),
    })
  }

  private emit(
    kind: ModLifecycle,
    mod: ModInstallDto,
    actor: ModActor,
    detail: Record<string, unknown>,
  ): void {
    this.events.enqueue(modEvent(kind, mod, actor.subject, detail))
  }

  /** Re-reads one install after a committed change. */
  private refresh(id: string): ModView {
    const mod = this.store.mods.get(id)
    if (!mod) {
      this.views.delete(id)
      throw new ModError('mod.not_found', `no mod ${id}`, 404)
    }
    const granted = new Set(
      this.store.mods
        .grants(id)
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

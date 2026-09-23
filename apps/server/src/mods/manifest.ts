/**
 * Mod manifest validation (mods/mod-manifest.v1, ADR-013).
 *
 * Structure is checked against the JSON Schema itself (Ajv, draft 2020-12,
 * with the SubjectRef and MediaRef contracts from openvibe-contracts), so the
 * schema proposed to Contracts and the one Games enforces are the same
 * document. `checkForGames` adds what only this runtime can judge.
 */
import { createRequire } from 'node:module'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { satisfiesRange } from 'openvibe-sdk/core'
import { MOD_MANIFEST_SCHEMA } from './manifestSchema.js'

interface ContractsModule {
  schema(ref: string): Record<string, unknown>
}
const contracts = createRequire(import.meta.url)('openvibe-contracts') as ContractsModule

export interface ModManifest {
  id: string
  name: string
  version: string
  description?: string
  publisher: { type: string; id: string }
  target: string
  runtime: string
  permissions: {
    capabilities: string[]
    events?: string[]
    modules?: string[]
    mediaNamespaces?: string[]
  }
  resources: { cpuMs: number; memoryMb: number; storageMb: number; outboundHosts?: string[] }
  assets?: { media_id: string; role?: string; variant?: string }[]
  compatibility: { runtime: string; contracts?: string }
  homepage?: string
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
ajv.addSchema(contracts.schema('identity.subject-ref@1'))
ajv.addSchema(contracts.schema('media.media-ref@1'))
const validateSchema = ajv.compile(MOD_MANIFEST_SCHEMA)

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/** Structural validation against mods/mod-manifest.v1. */
export function validateManifest(value: unknown): Validation<ModManifest> {
  if (validateSchema(value)) return { ok: true, value: value as unknown as ModManifest }
  return {
    ok: false,
    errors: (validateSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`),
  }
}

/** The browser game's only mod target and runtime today. */
export const GAMES_TARGET = 'games.browser'
export const CONTENT_RUNTIME = 'games-content@1'
/** Version of the content runtime, matched against compatibility.runtime. */
export const CONTENT_RUNTIME_VERSION = '1.0.0'

/**
 * Whether this server can run the manifest at all. Executable runtimes
 * (scripts) are refused here: they wait for OpenVibe.Host's sandbox
 * (Stage C). Only declarative content packs run in Games today.
 */
export function checkForGames(m: ModManifest): string[] {
  const errors: string[] = []
  if (m.target !== GAMES_TARGET) errors.push(`target ${m.target} is not ${GAMES_TARGET}`)
  if (m.runtime !== CONTENT_RUNTIME) {
    errors.push(
      `runtime ${m.runtime} is not available here: only ${CONTENT_RUNTIME} (declarative data packs) runs in Games until sandboxed execution exists`,
    )
  } else if (!safeSatisfies(CONTENT_RUNTIME_VERSION, m.compatibility.runtime)) {
    errors.push(
      `compatibility.runtime ${m.compatibility.runtime} does not include ${CONTENT_RUNTIME_VERSION}`,
    )
  }
  if (m.publisher.type !== 'user' && m.publisher.type !== 'app') {
    errors.push('publisher must be a user or an app subject')
  }
  if ((m.resources.outboundHosts ?? []).length > 0) {
    errors.push('content packs cannot reach the network: resources.outboundHosts must be empty')
  }
  return errors
}

function safeSatisfies(version: string, range: string): boolean {
  try {
    return satisfiesRange(version, range)
  } catch {
    return false
  }
}

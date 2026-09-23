/**
 * The Contracts proposals in docs/ stay valid and in step with the code:
 * capability manifests and the service manifest validate against the
 * released contracts, and every event type the service manifest declares is
 * one the code can actually emit.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CONTENT_RUNTIME_CAPABILITIES } from '../mods/contentPack.js'
import { CAP_MOD_MANAGE } from './staffAuth.js'

interface Contracts {
  validate(
    ref: string,
    value: unknown,
  ): { valid: boolean; errors: { path: string; message: string }[] }
}
const contracts = createRequire(import.meta.url)('openvibe-contracts') as Contracts
const DOCS = new URL('../../../../docs/', import.meta.url)
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(rel, DOCS), 'utf8')) as Record<string, unknown>

describe('Contracts proposals', () => {
  const capFiles = readdirSync(new URL('capabilities-proposal/', DOCS)).filter((f) =>
    f.endsWith('.json'),
  )

  it('capability manifests are valid capabilities.capability@1 with 3-segment ids', () => {
    expect(capFiles.length).toBeGreaterThan(0)
    for (const file of capFiles) {
      const cap = readJson(`capabilities-proposal/${file}`)
      expect(contracts.validate('capabilities.capability@1', cap).errors, file).toEqual([])
      expect(`${String(cap.id)}.json`).toBe(file)
    }
  })

  it('the service manifest is a valid registry.service-manifest@1 listing only games-owned capabilities', () => {
    const manifest = readJson('service-manifest-proposal.json')
    expect(contracts.validate('registry.service-manifest@1', manifest).errors).toEqual([])
    const listed = manifest.capabilities as string[]
    for (const id of listed) {
      const cap = readJson(`capabilities-proposal/${id}.json`)
      expect(cap.owner, id).toBe('games')
    }
    // Every capability Games checks is declared.
    for (const id of [...CONTENT_RUNTIME_CAPABILITIES, CAP_MOD_MANAGE]) {
      expect(listed).toContain(id)
    }
  })

  it('declares exactly the events the code emits', async () => {
    const manifest = readJson('service-manifest-proposal.json')
    const source = ['gameEvents.ts', '../mods/registry.ts']
      .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
      .join('\n')
    const lifecycles = ['installed', 'enabled', 'disabled', 'revoked', 'grants_changed']
    for (const type of manifest.eventsProduced as string[]) {
      const literal = source.includes(`'${type}'`)
      const mod = type.startsWith('games.mod.') && lifecycles.includes(type.slice(10))
      expect(literal || mod, type).toBe(true)
    }
  })
})

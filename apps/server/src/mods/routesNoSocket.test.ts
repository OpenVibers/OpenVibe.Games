import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createContent } from '@openvibe/content'
import { openTestStore } from '@openvibe/persistence/testing'
import { createConsoleLogger } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import { ModRegistry, type ModActor } from './registry.js'
import { handleModsRequest } from './routes.js'
import { sampleManifest } from './testFixtures.js'

const STAFF: ModActor = {
  audit: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
  subject: { type: 'user', id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' },
}
const log = createConsoleLogger({ app: 'test' }, 'error')

function post(
  registry: ModRegistry,
  body: unknown,
  staff: boolean,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage
    req.method = 'POST'
    req.url = '/api/v1/mods'
    const response = {
      statusCode: 200,
      setHeader() {
        return undefined
      },
      writeHead(status: number) {
        response.statusCode = status
        return undefined
      },
      end(value?: string) {
        resolve({
          status: response.statusCode,
          body: JSON.parse(value ?? '{}') as Record<string, unknown>,
        })
        return undefined
      },
    }
    const res = response as unknown as ServerResponse
    handleModsRequest(req, res, { registry, authorize: async () => (staff ? STAFF : null), log })
  })
}

describe('script install API without a listening socket', () => {
  it('refuses a non-staff install and accepts the same pack for staff', async () => {
    const registry = new ModRegistry(await openTestStore(), createContent())
    const request = {
      manifest: sampleManifest({
        runtime: 'games-quickjs@1',
        compatibility: { runtime: '>=1.0.0 <2.0.0' },
        permissions: { capabilities: ['games.script.run', 'games.players.read'] },
        resources: { cpuMs: 2, memoryMb: 8, storageMb: 1 },
      }),
      pack: {
        mods: [
          {
            format: 'games-quickjs@1',
            id: 'api_script',
            version: '1.0.0',
            entry: 'main.js',
            source: 'function onTick() {}',
            hooks: ['onTick'],
            capabilities: ['players.read'],
          },
        ],
      },
      approve: ['games.script.run', 'games.players.read'],
      enable: true,
    }
    expect(await post(registry, request, false)).toMatchObject({
      status: 403,
      body: { code: 'capability.denied' },
    })
    expect(registry.list()).toHaveLength(0)
    expect(await post(registry, request, true)).toMatchObject({
      status: 201,
      body: { status: 'enabled' },
    })
    expect(registry.list()).toHaveLength(1)
  })
})

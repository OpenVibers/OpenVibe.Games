import type { ModRepository } from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import type { Json } from './sandbox.js'
import type { ScriptStorage } from './host.js'

/** Serialized write-behind for script state. Reads load once before any sandbox starts. */
export class PgScriptStorage implements ScriptStorage {
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly mods: ModRepository,
    private readonly placeId: string,
    private readonly log: Logger,
  ) {}

  async load(modId: string): Promise<Record<string, Json>> {
    return (await this.mods.storage(modId, this.placeId)) as Record<string, Json>
  }

  set(modId: string, key: string, value: Json): void {
    this.enqueue(() => this.mods.setStorage(modId, this.placeId, key, value))
  }

  delete(modId: string, key: string): void {
    this.enqueue(() => this.mods.deleteStorage(modId, this.placeId, key))
  }

  async flushWrites(): Promise<void> {
    await this.writes
  }

  private enqueue(write: () => Promise<void>): void {
    this.writes = this.writes.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await write()
          return
        } catch (error) {
          if (attempt === 2) this.log.error('script storage write failed', { error: String(error) })
          else await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
        }
      }
    })
  }
}

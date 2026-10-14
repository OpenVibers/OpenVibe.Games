export * from './types.js'
export * from './time.js'
export * from './stats.js'
export * from './battle.js'
export * from './kit.js'
export * from './actions.js'
export * from './validate.js'
export { vibeHeroes } from './content/vibeHeroes.js'

import { vibeHeroes } from './content/vibeHeroes.js'
import type { CasualPack } from './types.js'

/** Every casual game, by id. */
export const CASUAL_GAMES: Record<string, CasualPack> = { [vibeHeroes.id]: vibeHeroes }

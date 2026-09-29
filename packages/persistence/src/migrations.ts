import { fileURLToPath } from 'node:url'

/** The migrations directory beside this package (packages/persistence/migrations). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

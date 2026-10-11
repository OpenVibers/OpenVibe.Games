import { z } from 'zod'

/**
 * `games-quickjs@1`: a server script mod carried by a content pack. The
 * manifest and the source travel together, so the def-set digest (pack.ts)
 * pins both: a client whose copy of a mod differs by one byte is refused at
 * the handshake like any other content difference.
 *
 * The server runs it in a QuickJS sandbox (apps/server/src/mods/script) only
 * when the place enables script mods; see docs/mods.md for the host API.
 */
export const SCRIPT_MOD_FORMAT = 'games-quickjs@1'

/** The hooks a mod may declare; the host calls only declared hooks. */
export const SCRIPT_MOD_HOOKS = ['onTick', 'onPlayerJoin', 'onPlayerLeave'] as const
export type ScriptModHook = (typeof SCRIPT_MOD_HOOKS)[number]

/**
 * Budget defaults and ceilings, per mod. `cpuMs` is per tick (every hook call
 * the mod gets in one tick shares it) and caps any single call; `memoryMb` is
 * the heap the mod may hold beyond the engine's fixed 16 MiB base; `stackKb`
 * its maximum stack.
 */
export const SCRIPT_MOD_BUDGETS = {
  cpuMs: { default: 2, max: 10 },
  memoryMb: { default: 8, max: 32 },
  // Past ~256 KiB of QuickJS stack the host's own (native) stack runs out first.
  stackKb: { default: 128, max: 256 },
} as const

/** Longest source a mod may carry, in UTF-16 code units. */
export const MAX_SCRIPT_SOURCE = 64 * 1024
export const SCRIPT_CAPABILITIES = [
  'players.read',
  'player.message',
  'world.emit',
  'storage.kv',
] as const
export type ScriptCapability = (typeof SCRIPT_CAPABILITIES)[number]

const slug = /^[a-z0-9][a-z0-9_-]{0,39}$/
const modulePath = /^(?:[a-z0-9][a-z0-9_-]{0,39}\/)*[a-z0-9][a-z0-9_-]{0,39}\.js$/

/** Checks static imports before install; the runtime loader repeats the containment check. */
export function moduleImportErrors(files: Record<string, string>): string[] {
  const errors: string[] = []
  for (const [file, source] of Object.entries(files)) {
    if (/\bimport\s*\(/.test(source)) errors.push(`${file}: dynamic imports are not supported`)
    const refs = source.matchAll(/\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)
    for (const [, ref] of refs) {
      if (!ref?.startsWith('./') && !ref?.startsWith('../')) {
        errors.push(`${file}: only relative imports are allowed: ${ref}`)
        continue
      }
      const parts: string[] = []
      let escaped = false
      for (const part of `${file.slice(0, file.lastIndexOf('/') + 1)}${ref}`.split('/')) {
        if (part === '..') {
          if (parts.length === 0) escaped = true
          else parts.pop()
        } else if (part !== '.' && part !== '') parts.push(part)
      }
      const resolved = parts.join('/')
      if (escaped) errors.push(`${file}: import leaves pack: ${ref}`)
      else if (!(resolved in files)) errors.push(`${file}: missing module: ${resolved}`)
    }
  }
  return errors
}

export const ScriptModSchema = z
  .object({
    format: z.literal(SCRIPT_MOD_FORMAT),
    id: z.string().regex(slug),
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    /** Entry and module paths are pack-relative. Legacy single-source entries remain valid. */
    entry: z.string().regex(modulePath),
    source: z.string().min(1).max(MAX_SCRIPT_SOURCE).optional(),
    files: z.record(z.string()).optional(),
    /** Absent means the legacy bindings; an explicit list opts in to per-binding grants. */
    capabilities: z
      .array(z.enum(SCRIPT_CAPABILITIES))
      .max(SCRIPT_CAPABILITIES.length)
      .refine((c) => new Set(c).size === c.length, 'capabilities must be unique')
      .optional(),
    /** Server-approved subset, pinned by the definition digest. Populated by the pack loader. */
    granted: z.array(z.enum(SCRIPT_CAPABILITIES)).optional(),
    hooks: z
      .array(z.enum(SCRIPT_MOD_HOOKS))
      .min(1)
      .max(SCRIPT_MOD_HOOKS.length)
      .refine((h) => new Set(h).size === h.length, 'hooks must be unique'),
    /** Requested budgets; anything omitted takes the default. */
    budgets: z
      .object({
        cpuMs: z.number().positive().max(SCRIPT_MOD_BUDGETS.cpuMs.max).optional(),
        memoryMb: z.number().int().min(1).max(SCRIPT_MOD_BUDGETS.memoryMb.max).optional(),
        stackKb: z.number().int().min(64).max(SCRIPT_MOD_BUDGETS.stackKb.max).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((mod, ctx) => {
    if (!mod.source && !mod.files)
      ctx.addIssue({ code: 'custom', message: 'source or files is required' })
    if (mod.files) {
      if (mod.source) ctx.addIssue({ code: 'custom', message: 'source and files are exclusive' })
      if (Object.keys(mod.files).length > 32)
        ctx.addIssue({ code: 'custom', message: 'at most 32 mod files' })
      if (!(mod.entry in mod.files))
        ctx.addIssue({ code: 'custom', message: 'entry is missing from files' })
      const bytes = Object.entries(mod.files).reduce((n, [path, body]) => {
        if (!modulePath.test(path))
          ctx.addIssue({ code: 'custom', message: `invalid module path ${path}` })
        return n + new TextEncoder().encode(path).length + new TextEncoder().encode(body).length
      }, 0)
      if (bytes > MAX_SCRIPT_SOURCE)
        ctx.addIssue({ code: 'custom', message: 'mod files exceed 64 KiB' })
      for (const message of moduleImportErrors(mod.files)) ctx.addIssue({ code: 'custom', message })
    }
  })

export type ScriptMod = z.infer<typeof ScriptModSchema>

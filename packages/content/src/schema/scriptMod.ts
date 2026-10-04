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

const slug = /^[a-z0-9][a-z0-9_-]{0,39}$/

export const ScriptModSchema = z
  .object({
    format: z.literal(SCRIPT_MOD_FORMAT),
    id: z.string().regex(slug),
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    /** The script's file name, used in stack traces; v1 mods are one script (no module loader). */
    entry: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}\.js$/),
    source: z.string().min(1).max(MAX_SCRIPT_SOURCE),
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

export type ScriptMod = z.infer<typeof ScriptModSchema>

/**
 * Intent bitfield: the named actions an input command expresses, as fixed
 * bits. This is the single definition — the protocol, the movement layer and
 * (M2) touch controls all map onto these names, so a key press and a touch
 * button produce the same intent.
 *
 * Adding a flag takes the next free bit and bumps INTENTS_VERSION (and so the
 * wire protocol version, because the bits are on the wire).
 */
export const Intents = Object.freeze({
  Jump: 1 << 0,
  Crouch: 1 << 1,
  Sprint: 1 << 2,
  Use: 1 << 3,
  Attack: 1 << 4,
  Prone: 1 << 5,
} as const)

export type IntentName = keyof typeof Intents

/** Bump when a flag is added or a bit changes meaning. */
export const INTENTS_VERSION = 1

/** Every known bit; an inbound command may carry no bit outside this mask. */
export const intentMask = Object.values(Intents).reduce((mask, bit) => mask | bit, 0)

/** Is the named intent set in a bitfield? */
export function hasIntent(bits: number, name: IntentName): boolean {
  return (bits & Intents[name]) !== 0
}

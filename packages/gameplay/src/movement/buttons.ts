/**
 * Input intent bitfield. The single definition lives in @openvibe/shared
 * (protocol + gameplay + M2 touch); `Buttons` stays the movement layer's
 * alias so the simulation keeps reading button bits.
 */
export {
  Intents,
  Intents as Buttons,
  INTENTS_VERSION,
  intentMask,
  hasIntent,
  type IntentName,
} from '@openvibe/shared'

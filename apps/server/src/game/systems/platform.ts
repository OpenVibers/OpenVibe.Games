import type { SkillSet } from '@openvibe/gameplay'
import type { EventPlayer, ProgressSnapshot } from '../../platform/gameEvents.js'
import type { PlayerSession } from '../playerSession.js'

/**
 * Pure adapters between a session and the platform event/progress payloads. Both the session
 * lifecycle (join) and the persistence flusher (saves, leaves) need them, so they live here rather
 * than inside either system.
 */

/** A session as the platform event recorder sees it. */
export function eventPlayer(session: PlayerSession): EventPlayer {
  return {
    playerId: session.playerId as string,
    slot: session.charSlot,
    name: session.name,
    subjectId: session.subjectId,
  }
}

export function progressOf(skills: SkillSet, unlocks: Iterable<string>): ProgressSnapshot {
  const levels: Record<string, number> = {}
  for (const skill of skills.all()) levels[skill.id] = skill.level
  return { levels, unlocks: [...unlocks] }
}

export function sessionProgress(session: PlayerSession): ProgressSnapshot {
  return progressOf(session.skills, session.unlocks)
}

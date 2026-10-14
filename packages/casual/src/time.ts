/** Resets happen at 00:00 UTC (days) and Monday 00:00 UTC (weeks), the same for every player. */

const DAY = 86_400_000

/** `2026-10-14` for a time in that UTC day. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** The ISO week number since the epoch's first Monday (1970-01-05), stable and comparable. */
export function weekIndex(now: number): number {
  return Math.floor((now - 4 * DAY) / (7 * DAY))
}

export function weekKey(now: number): string {
  return `w${weekIndex(now)}`
}

/** The next 00:00 UTC after `now`. */
export function nextDay(now: number): number {
  return (Math.floor(now / DAY) + 1) * DAY
}

/** The next Monday 00:00 UTC after `now`. */
export function nextWeek(now: number): number {
  return (weekIndex(now) + 1) * 7 * DAY + 4 * DAY
}

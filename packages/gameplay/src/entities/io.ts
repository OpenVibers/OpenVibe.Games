/**
 * The deterministic I/O queue. One event edge is an output: when `event`
 * fires, send `input` to `target` after `delay` seconds. Seconds become
 * whole ticks with `Math.round`, so the same map and the same tick rate
 * always produce the same ordering — server and prediction cannot disagree
 * about when something fires.
 */

export interface OutputSpec {
  event: string
  target: string
  input: string
  param?: string
  delay?: number
  once?: boolean
}

export interface QueuedOutput {
  dueTick: number
  /** Monotonic insertion order, the tie-breaker when two edges share a tick. */
  seq: number
  event: string
  target: string
  input: string
  param?: string
  once?: boolean
}

export function delayTicks(delaySeconds: number | undefined, tickRate: number): number {
  if (delaySeconds === undefined || delaySeconds <= 0) return 0
  return Math.round(delaySeconds * tickRate)
}

/** A stable identity for an output, used to honour `once`. */
export function outputKey(output: OutputSpec): string {
  return `${output.event}\u0000${output.target}\u0000${output.input}\u0000${output.param ?? ''}`
}

export class OutputQueue {
  private items: QueuedOutput[] = []
  private nextSeq = 0

  get length(): number {
    return this.items.length
  }

  schedule(outputs: readonly OutputSpec[], nowTick: number, tickRate: number): void {
    for (const output of outputs) {
      this.items.push({
        dueTick: nowTick + delayTicks(output.delay, tickRate),
        seq: this.nextSeq++,
        event: output.event,
        target: output.target,
        input: output.input,
        ...(output.param !== undefined ? { param: output.param } : {}),
        ...(output.once !== undefined ? { once: output.once } : {}),
      })
    }
    this.items.sort((a, b) => a.dueTick - b.dueTick || a.seq - b.seq)
  }

  /** Pop every edge due at or before `nowTick`, in (dueTick, seq) order. */
  due(nowTick: number): QueuedOutput[] {
    const out: QueuedOutput[] = []
    while (this.items.length > 0 && this.items[0]!.dueTick <= nowTick) {
      out.push(this.items.shift()!)
    }
    return out
  }

  clear(): void {
    this.items = []
  }
}

/**
 * Fixed-timestep accumulator shared by the server loop and client prediction.
 * Simulation never depends on render/frame timing: callers feed real elapsed
 * time in, and `consume` yields how many fixed steps to run.
 */
export const SIM_TICK_RATE = 30
export const SIM_DT = 1 / SIM_TICK_RATE

/**
 * Native CS:S surf rate. Surf rooms simulate at this rate with the unscaled
 * Source air cap (0.762 m/s per tick); other rooms stay at SIM_TICK_RATE.
 * The process scheduler runs at least this fast, and each room's accumulator
 * decides how many of its own fixed steps to take.
 */
export const SURF_TICK_RATE = 100
/** Snapshots every N surf ticks → 25 Hz, inside Source's 20–30 Hz range. */
export const SURF_SNAPSHOT_EVERY = 4

export class FixedTimestep {
  private accumulator = 0
  constructor(
    readonly dt: number = SIM_DT,
    /** Cap prevents spiral-of-death after long stalls (tab hidden, GC pause). */
    private readonly maxSteps: number = 8,
  ) {}

  /** Feed elapsed real seconds; returns the number of fixed steps to simulate. */
  consume(elapsed: number): number {
    this.accumulator += elapsed
    let steps = Math.floor(this.accumulator / this.dt)
    if (steps > this.maxSteps) {
      steps = this.maxSteps
      this.accumulator = 0
    } else {
      this.accumulator -= steps * this.dt
    }
    return steps
  }

  /** Interpolation alpha in [0,1) for rendering between fixed steps. */
  get alpha(): number {
    return this.accumulator / this.dt
  }

  reset(): void {
    this.accumulator = 0
  }
}

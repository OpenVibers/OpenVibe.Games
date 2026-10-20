/**
 * Scraplandia's sounds, synthesised with Web Audio: no files to fetch, so
 * nothing to wait for and nothing to break. The game had no sound at all —
 * no footsteps, no thunk when an axe bites, no wind — which is a large part
 * of why walking around felt dead.
 *
 * Everything goes through one master gain (the Settings volume, kept in
 * localStorage) and a low-pass that closes while the camera is under water.
 * Browsers only start audio after a gesture, so the context is created on
 * the first click or key (unlock()).
 */

export type Surface = 'grass' | 'stone' | 'water'
export type HitMaterial = 'wood' | 'stone' | 'metal' | 'flesh' | 'plant'
export type Weather = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog'

const VOLUME_KEY = 'scraplandia:volume'
const DEFAULT_VOLUME = 0.6

export function readVolume(storage: Pick<Storage, 'getItem'> | null = safeStorage()): number {
  const raw = storage?.getItem(VOLUME_KEY)
  const v = raw === null || raw === undefined ? NaN : Number(raw)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME
}

export function saveVolume(
  v: number,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(VOLUME_KEY, String(Math.min(1, Math.max(0, v))))
  } catch {
    // private mode: the volume lasts this visit
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * What the player's feet are on: water below the waterline, stone when they
 * stand above the terrain (a pavement slab, a floor, a rock), grass otherwise.
 */
export function footstepSurface(feetY: number, groundY: number, waterLevel: number): Surface {
  if (groundY < waterLevel - 0.03 && feetY < waterLevel + 0.2) return 'water'
  return feetY - groundY > 0.12 ? 'stone' : 'grass'
}

/** The sound a node's look makes when hit (resource node `visual`). */
export function materialForVisual(visual: string | undefined): HitMaterial {
  switch (visual) {
    case 'tree':
    case 'branches':
      return 'wood'
    case 'rock':
    case 'stones':
      return 'stone'
    case 'scrap':
      return 'metal'
    default:
      return 'plant'
  }
}

interface Env {
  attack: number
  decay: number
  gain: number
}

export class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private muffle: BiquadFilterNode | null = null
  private noise: AudioBuffer | null = null
  private volume = readVolume()
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null
  private rain: GainNode | null = null
  private weather: Weather = 'clear'
  private underwater = false
  private nextBird = 0
  private nextCricket = 0
  private windPhase = 0

  /** Starts audio on the first gesture (browsers refuse earlier); later calls only resume it. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.ctx = ctx
    this.muffle = ctx.createBiquadFilter()
    this.muffle.type = 'lowpass'
    this.muffle.frequency.value = 20000
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.muffle.connect(this.master).connect(ctx.destination)
    // Two seconds of white noise feed every hiss, crunch and whoosh.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.startAmbience(ctx)
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    saveVolume(this.volume)
    if (this.ctx && this.master)
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05)
  }

  getVolume(): number {
    return this.volume
  }

  setWeather(w: Weather): void {
    this.weather = w
  }

  setUnderwater(on: boolean): void {
    if (on === this.underwater) return
    this.underwater = on
    if (this.ctx && this.muffle)
      this.muffle.frequency.setTargetAtTime(on ? 500 : 20000, this.ctx.currentTime, 0.08)
  }

  footstep(surface: Surface, sprinting: boolean): void {
    const loud = sprinting ? 1.25 : 1
    if (surface === 'water') {
      this.burst(
        'bandpass',
        900 + Math.random() * 500,
        0.9,
        { attack: 0.01, decay: 0.2, gain: 0.22 * loud },
        1.6,
      )
      return
    }
    if (surface === 'stone') {
      this.burst('bandpass', 1900 + Math.random() * 600, 1.3, {
        attack: 0.002,
        decay: 0.05,
        gain: 0.2 * loud,
      })
      this.tone('sine', 120, 90, { attack: 0.002, decay: 0.04, gain: 0.1 * loud })
      return
    }
    this.burst('lowpass', 700 + Math.random() * 400, 0.8, {
      attack: 0.005,
      decay: 0.09,
      gain: 0.24 * loud,
    })
    this.tone('sine', 80, 60, { attack: 0.003, decay: 0.05, gain: 0.08 * loud })
  }

  jump(): void {
    this.burst('lowpass', 800, 0.7, { attack: 0.005, decay: 0.06, gain: 0.1 })
  }

  /** strength 0..1 from the falling speed. */
  land(strength: number): void {
    const s = Math.min(1, Math.max(0.2, strength))
    this.tone('sine', 75, 45, { attack: 0.003, decay: 0.14, gain: 0.35 * s })
    this.burst('lowpass', 500, 0.7, { attack: 0.003, decay: 0.1, gain: 0.25 * s })
  }

  swing(): void {
    if (!this.ctx) return
    const src = this.noiseSource()
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 1.4
    const t = this.ctx.currentTime
    filter.frequency.setValueAtTime(500, t)
    filter.frequency.exponentialRampToValueAtTime(2400, t + 0.16)
    src.connect(filter)
    this.envelope(filter, { attack: 0.05, decay: 0.14, gain: 0.14 }, src)
  }

  hit(material: HitMaterial): void {
    switch (material) {
      case 'wood':
        this.tone('triangle', 220, 150, { attack: 0.002, decay: 0.13, gain: 0.45 })
        this.burst('bandpass', 1300, 2.5, { attack: 0.001, decay: 0.05, gain: 0.35 })
        break
      case 'stone':
        this.burst('bandpass', 3200, 1.8, { attack: 0.001, decay: 0.07, gain: 0.45 })
        this.tone('square', 950, 620, { attack: 0.001, decay: 0.035, gain: 0.08 })
        break
      case 'metal':
        // Inharmonic partials ring like a struck sheet.
        this.tone('sine', 523, 520, { attack: 0.001, decay: 0.5, gain: 0.16 })
        this.tone('sine', 1307, 1300, { attack: 0.001, decay: 0.32, gain: 0.09 })
        this.tone('sine', 2051, 2040, { attack: 0.001, decay: 0.22, gain: 0.06 })
        this.burst('highpass', 4000, 0.7, { attack: 0.001, decay: 0.02, gain: 0.2 })
        break
      case 'flesh':
        this.burst('lowpass', 520, 0.8, { attack: 0.002, decay: 0.09, gain: 0.35 })
        this.tone('sine', 95, 70, { attack: 0.002, decay: 0.08, gain: 0.2 })
        break
      case 'plant':
        this.burst('bandpass', 2600, 0.9, { attack: 0.004, decay: 0.12, gain: 0.18 })
        break
    }
  }

  /** Something went into the pack. */
  pickup(): void {
    this.tone('sine', 660, 700, { attack: 0.004, decay: 0.07, gain: 0.12 })
    this.tone('sine', 990, 1040, { attack: 0.004, decay: 0.09, gain: 0.1 }, 0.06)
  }

  levelUp(): void {
    ;[523, 659, 784, 1047].forEach((f, i) =>
      this.tone('triangle', f, f, { attack: 0.005, decay: 0.22, gain: 0.12 }, i * 0.08),
    )
  }

  hurt(): void {
    this.tone('sawtooth', 210, 110, { attack: 0.003, decay: 0.16, gain: 0.12 })
    this.burst('lowpass', 600, 0.8, { attack: 0.002, decay: 0.08, gain: 0.25 })
  }

  click(): void {
    this.tone('sine', 1700, 1500, { attack: 0.001, decay: 0.025, gain: 0.05 })
  }

  /**
   * Ambience, every frame: wind always (stronger in a storm), birds by day,
   * crickets at night, rain hiss in rain. daylight is 0 at night, 1 at noon.
   */
  update(dt: number, daylight: number): void {
    const ctx = this.ctx
    if (!ctx || !this.wind || !this.rain) return
    const t = ctx.currentTime
    this.windPhase += dt
    const stormy = this.weather === 'storm' ? 1 : this.weather === 'rain' ? 0.5 : 0
    const gust = 0.5 + 0.5 * Math.sin(this.windPhase * 0.23) * Math.sin(this.windPhase * 0.071 + 1)
    this.wind.gain.gain.setTargetAtTime(0.035 + gust * 0.03 + stormy * 0.08, t, 0.5)
    this.wind.filter.frequency.setTargetAtTime(320 + gust * 500 + stormy * 400, t, 0.5)
    this.rain.gain.setTargetAtTime(stormy * 0.09, t, 1)
    if (this.underwater || stormy > 0) return
    if (daylight > 0.25 && t >= this.nextBird) {
      this.nextBird = t + 2 + Math.random() * 6
      this.birdCall()
    }
    if (daylight < 0.05 && t >= this.nextCricket) {
      this.nextCricket = t + 0.5 + Math.random() * 1.2
      this.cricket()
    }
  }

  // ── Building blocks ────────────────────────────────────────────────

  private startAmbience(ctx: AudioContext): void {
    const windSrc = this.noiseSource(true)
    const windFilter = ctx.createBiquadFilter()
    windFilter.type = 'lowpass'
    windFilter.frequency.value = 400
    windFilter.Q.value = 0.6
    const windGain = ctx.createGain()
    windGain.gain.value = 0
    windSrc.connect(windFilter).connect(windGain).connect(this.muffle!)
    windSrc.start()
    this.wind = { gain: windGain, filter: windFilter }
    const rainSrc = this.noiseSource(true)
    const rainFilter = ctx.createBiquadFilter()
    rainFilter.type = 'highpass'
    rainFilter.frequency.value = 1200
    const rainGain = ctx.createGain()
    rainGain.gain.value = 0
    rainSrc.connect(rainFilter).connect(rainGain).connect(this.muffle!)
    rainSrc.start()
    this.rain = rainGain
  }

  private birdCall(): void {
    const ctx = this.ctx!
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.random() * 1.6 - 0.8
    pan.connect(this.muffle!)
    const base = 2400 + Math.random() * 1800
    const notes = 2 + Math.floor(Math.random() * 3)
    for (let i = 0; i < notes; i++) {
      const at = ctx.currentTime + i * (0.11 + Math.random() * 0.05)
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(base, at)
      osc.frequency.exponentialRampToValueAtTime(base * (1.25 + Math.random() * 0.3), at + 0.04)
      osc.frequency.exponentialRampToValueAtTime(base * 0.9, at + 0.09)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(0.025, at + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.1)
      osc.connect(g).connect(pan)
      osc.start(at)
      osc.stop(at + 0.12)
    }
  }

  private cricket(): void {
    const ctx = this.ctx!
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.random() * 1.4 - 0.7
    pan.connect(this.muffle!)
    for (let i = 0; i < 3; i++) {
      const at = ctx.currentTime + i * 0.045
      const osc = ctx.createOscillator()
      osc.frequency.value = 4300
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(0.012, at + 0.008)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.03)
      osc.connect(g).connect(pan)
      osc.start(at)
      osc.stop(at + 0.04)
    }
  }

  private noiseSource(loop = false): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource()
    src.buffer = this.noise
    src.loop = loop
    if (!loop) src.playbackRate.value = 0.85 + Math.random() * 0.3
    return src
  }

  /** A filtered noise hit. `sweep` > 1 glides the filter up by that ratio. */
  private burst(type: BiquadFilterType, freq: number, q: number, env: Env, sweep = 1): void {
    if (!this.ctx) return
    const src = this.noiseSource()
    const filter = this.ctx.createBiquadFilter()
    filter.type = type
    filter.Q.value = q
    const t = this.ctx.currentTime
    filter.frequency.setValueAtTime(freq, t)
    if (sweep !== 1)
      filter.frequency.exponentialRampToValueAtTime(freq * sweep, t + env.attack + env.decay)
    src.connect(filter)
    this.envelope(filter, env, src)
  }

  /** A pitched blip gliding from `from` to `to` Hz, `delay` seconds from now. */
  private tone(type: OscillatorType, from: number, to: number, env: Env, delay = 0): void {
    if (!this.ctx) return
    const osc = this.ctx.createOscillator()
    osc.type = type
    const t = this.ctx.currentTime + delay
    osc.frequency.setValueAtTime(from, t)
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + env.attack + env.decay)
    this.envelope(osc, env, osc, delay)
  }

  private envelope(node: AudioNode, env: Env, source: AudioScheduledSourceNode, delay = 0): void {
    const ctx = this.ctx!
    const t = ctx.currentTime + delay
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(env.gain, t + env.attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + env.attack + env.decay)
    node.connect(g).connect(this.muffle!)
    source.start(t)
    source.stop(t + env.attack + env.decay + 0.02)
  }
}

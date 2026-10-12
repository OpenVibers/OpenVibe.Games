import type { ServerMessage } from '@openvibe/protocol'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import './salvageRushHud.css'

type Round = Extract<ServerMessage, { t: 'salvage_round' }>

/** Loaded only in the arena, after the content handshake chooses its place. */
export class SalvageRushHud {
  private readonly root: HTMLElement
  private readonly phase: HTMLElement
  private readonly time: HTMLElement
  private readonly scores: HTMLElement
  private timer: number | null = null
  private pickups: Mesh[] = []

  constructor(
    parent: HTMLElement,
    private readonly scene: Scene,
  ) {
    this.root = document.createElement('aside')
    this.root.className = 'rush-hud'
    this.root.setAttribute('aria-label', 'Salvage Rush round')
    const head = document.createElement('div')
    head.className = 'rush-head'
    const title = document.createElement('strong')
    title.textContent = 'SALVAGE RUSH'
    this.phase = document.createElement('span')
    this.phase.className = 'rush-phase'
    head.append(title, this.phase)
    this.time = document.createElement('p')
    this.time.className = 'rush-time'
    this.time.setAttribute('aria-live', 'off')
    this.scores = document.createElement('ol')
    this.scores.className = 'rush-scores'
    this.root.append(head, this.time, this.scores)
    parent.append(this.root)
  }

  update(round: Round): void {
    if (this.pickups.length !== round.pickups.length) {
      for (const mesh of this.pickups) mesh.dispose()
      this.pickups = round.pickups.map((point, i) => {
        const mesh = MeshBuilder.CreateSphere(`rush-pickup-${i}`, { diameter: 0.8 }, this.scene)
        mesh.position.set(point.x, 1.1, point.z)
        const material = new StandardMaterial(`rush-pickup-material-${i}`, this.scene)
        material.diffuseColor = new Color3(0.95, 0.7, 0.25)
        material.emissiveColor = new Color3(0.5, 0.26, 0.04)
        mesh.material = material
        return mesh
      })
    }
    round.pickups.forEach((point, i) =>
      this.pickups[i]?.setEnabled(round.phase === 'active' && point.available),
    )
    if (this.timer !== null) window.clearInterval(this.timer)
    const active = round.phase === 'active'
    this.root.classList.toggle('is-active', active)
    this.phase.textContent = active ? 'Collect scrap' : 'Next round in'
    const refresh = () => {
      const remaining = Math.max(0, Math.ceil((round.endsAt - Date.now()) / 1000))
      const m = Math.floor(remaining / 60)
      this.time.textContent = `${m}:${String(remaining % 60).padStart(2, '0')}`
      this.root.classList.toggle('is-ending', active && remaining <= 10)
    }
    refresh()
    this.timer = window.setInterval(refresh, 250)
    this.scores.replaceChildren(
      ...round.scores.map((entry) => {
        const item = document.createElement('li')
        if (entry.rank <= 3) item.className = `rush-top-${entry.rank}`
        const rank = document.createElement('span')
        rank.className = 'rush-rank'
        rank.textContent = String(entry.rank)
        const name = document.createElement('span')
        name.className = 'rush-name'
        name.textContent = entry.name
        const score = document.createElement('span')
        score.className = 'rush-score'
        score.textContent = String(entry.score)
        item.append(rank, name, score)
        return item
      }),
    )
    if (!round.scores.length) {
      const empty = document.createElement('li')
      empty.className = 'rush-empty'
      empty.textContent = active
        ? 'Grab the glowing scrap to score.'
        : 'Scores appear when the round starts.'
      this.scores.append(empty)
    }
  }
}

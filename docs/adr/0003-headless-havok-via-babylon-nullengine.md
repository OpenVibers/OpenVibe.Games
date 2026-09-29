# ADR-0003: Server physics = Havok wasm via Babylon NullEngine adapter

**Status:** superseded by ADR-0007 · **Date:** 2026-08-09

> Superseded 2026-09-29: ADR-0007 decision 2 replaces Havok and the Babylon
> NullEngine host with Rapier on both sides, so `packages/physics/src/havok` and
> the NullEngine scene are gone. The rule this ADR established — one physics
> implementation behind `PhysicsWorld`, manual stepping, no engine types across
> the boundary — is kept; only the engine changed.

## Decision

The dedicated server runs the same Havok wasm as the browser, through the
same `@openvibe/physics/havok` adapter, hosted in a never-rendered NullEngine
scene. Stepping is manual (`plugin.executeStep`) from the fixed tick;
scene-driven physics stepping is disabled on both sides.

## Why

- One physics implementation and one adapter = identical collision behavior
  for server authority and client prediction; no cross-engine drift.
- Babylon's Physics V2 plugin is a maintained, typed binding to Havok's wasm;
  binding raw Havok directly would duplicate that work for little gain.
- NullEngine is Node-safe; measured cost of the scene host is negligible
  (tick ≈ 0.2 ms with the slice world).

## Consequences

- The server carries a @babylonjs/core dependency (adapter-internal only —
  no Babylon types cross the PhysicsWorld boundary, so a leaner binding can
  replace the adapter later without touching gameplay/server systems).
- "Sleep" is defined by adapter-level velocity thresholds (portable), not
  Havok's internal activation state.

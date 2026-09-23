# ADR-0006: Canonical Network subjects, and the platform boundary

**Status:** accepted · **Date:** 2026-09-22 · partly supersedes ADR-0004

## Decision

1. **Identity.** A signed-in account's characters are keyed by its canonical
   openvibe.network subject (`usr_…`, or `gst_…` for a Network guest), read
   from the token's `subject_id` claim once the Network has accepted the
   token (`/api/auth/me`). The subject is stored as the account key
   (`players.token`) and in `players.subject_id`.
   Accounts created earlier were keyed `ovn:<network user id>`. They are
   adopted into the subject key on their next sign-in, or in bulk by
   `apps/server/scripts/migrateIdentity.ts` (Network identity service,
   `identity.subject.resolve`). Adoption is idempotent, keeps every player id
   (friends, prop ownership and trust keep working), never overwrites a slot
   the subject already uses, and records `legacy_key -> subject` in
   `identity_legacy_map`. A token older than subjects keeps the legacy key.
2. **Guests** stay local (ADR-0004), but a guest token must be 8–64 of
   `[A-Za-z0-9_-]` and may not start with a subject prefix (`usr_`, `gst_`,
   …); the client mints 32 alphanumerics. Before this, any 8–64 character
   token was accepted, so a guest could present `ovn:<id>` and open that
   account's characters; now a token shaped like an account key is refused.
3. **Service calls** to other OpenVibe services carry a client-credentials
   token of the `games` principal (one per audience). No shared keys.
4. **Platform adapters live in `apps/server/src/platform` and
   `apps/server/src/mods`**, outside the simulation packages: durable events
   through a transactional outbox, Media copies of map assets, and the mod
   registry and runtime seam. The gameplay packages are unchanged; the
   persistence package gained repositories and a `transaction()` so a flush
   and the events describing it commit together.

## Why

The platform identifies people by subject (roadmap §16.6, ADR-001 in
OpenVibe.Contracts); the Network's integer ids are a service-local detail.
Keying by subject is also what lets events, Media owners and mod grants name
the same person Games does.

## Consequences

- A character's account key changes once; its player id never does.
- Characters left under a legacy key because of a slot conflict stay
  reachable under that key and are reported by the migration.

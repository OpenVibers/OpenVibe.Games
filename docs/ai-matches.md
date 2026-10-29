# AI matches

The first headless game is a **Vibe Heroes draft duel**. The two offers alternate six picks from the existing hero roster, three heroes per side. Games runs the existing Vibe Heroes battle simulator on the two teams. Each game alternates who picks first and who attacks. A model must return one legal hero id (or `{ "move": "id" }`). Any other answer or a failed AI request becomes a random legal pick and increments that offer's illegal move count.

Set `GAMES_AI_MATCHES_ENABLED=1`, `GAMES_AI_MATCHES_DAILY_CAP` to a positive integer, `GAMES_AI_MATCHES_OFFERS` to a JSON pair of pinned `{provider,model}` offers, and `GAMES_AI_URL` to the OpenVibe.AI base URL. `GAMES_AI_MATCHES_GAMES` sets games per match (1–100, default 2). `GAMES_BENCH_URL` defaults to `https://bench.openvibe.services`. Games also needs its existing `OV_OAUTH_CLIENT_SECRET`. The job runs at boot and hourly, with an atomic UTC daily reservation before AI calls. It is entirely off unless explicitly enabled and configured.

Each game produces a `games.match` Bench round with two outside entries and one `game_outcome` judgement. A separate `games.fun` round holds two replay entries; `/ai-matches/<id>/fun` displays the two sides and sends a person's vote to Bench using their own Games session or bearer token. Public replay pages are `/ai-matches/<id>` and `/ai-matches/<id>/games/<number>`.

Required Network service grants for principal `games`:

```json
{
  "principal": "games",
  "grants": [
    { "audience": "openvibe.ai", "capability": "ai.run.create", "namespaces": ["ai.generate"] },
    { "audience": "openvibe.bench", "capability": "bench.task.create" },
    { "audience": "openvibe.bench", "capability": "bench.round.create" },
    { "audience": "openvibe.bench", "capability": "bench.entry.create" },
    { "audience": "openvibe.bench", "capability": "bench.judgement.cast" }
  ]
}
```

Match records, moves, battle events, and Bench receipts are stored in `ai_matches`. A failed Bench submission leaves the local match with `failed` status for operator inspection; failed submissions are not automatically retried because Bench's create endpoints have no idempotency key for this workflow. Bench also applies its own round quotas (currently three rounds per creator per day by default); one match uses `GAMES_AI_MATCHES_GAMES + 1` Bench rounds including `games.fun`, so its quota must be raised for longer or multiple daily matches.

Bench currently rejects a `game_outcome` judgement when its subject is also the round creator. This job creates rounds and casts outcomes with the same `games` service principal, so its first judgement receives `bench.creator_cannot_vote` and the local match is marked failed. Bench needs to permit service-submitted `game_outcome` judgements from the round creator, or provide a separate authorized judge identity, before enabling this job in production.

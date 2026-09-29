-- phase: expand
-- OpenVibe.Games on PostgreSQL 18 (ADR-0007 decision 5): the schema from scratch. No SQLite history, no
-- data migration, no schema_version row. Text columns are COLLATE "C" so they compare the way the old
-- SQLite keys did; epoch-millisecond timestamps are bigint (the SDK returns int8 as Number); JSON is jsonb
-- and round-trips as objects. The event outbox and the token-revocation table are exactly the DDL
-- openvibe-sdk/events outboxSchema() and openvibe-sdk/auth revocationSchema() expect, so the platform
-- adapters need no ensureSchema() at boot.

-- A place is a map plus its persistent state (ADR-0007 decision 4). M1 runs one instance per place; the
-- server upserts its configured place (GAMES_PLACE_ID, default 'scraplandia') before any world write.
CREATE TABLE places (
    id         text COLLATE "C" PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-place key/value state: env_time, env_weather, market_<id>, world_seeded, world_id.
CREATE TABLE world_meta (
    place_id text NOT NULL REFERENCES places(id),
    key      text COLLATE "C" NOT NULL,
    value    jsonb NOT NULL,
    PRIMARY KEY (place_id, key)
);

CREATE TABLE world_entities (
    place_id   text NOT NULL REFERENCES places(id),
    id         text COLLATE "C" NOT NULL,
    kind       text NOT NULL,
    def_id     text NOT NULL,
    owner_id   text,
    pos_x      double precision NOT NULL,
    pos_y      double precision NOT NULL,
    pos_z      double precision NOT NULL,
    rot_x      double precision NOT NULL,
    rot_y      double precision NOT NULL,
    rot_z      double precision NOT NULL,
    rot_w      double precision NOT NULL,
    motion     text NOT NULL,
    state      jsonb,
    updated_at bigint NOT NULL,
    PRIMARY KEY (place_id, id)
);
CREATE INDEX world_entities_kind ON world_entities (place_id, kind);
CREATE INDEX world_entities_owner ON world_entities (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE world_constraints (
    place_id   text NOT NULL REFERENCES places(id),
    id         text COLLATE "C" NOT NULL,
    type       text NOT NULL,
    entity_a   text NOT NULL,
    entity_b   text NOT NULL,
    params     jsonb,
    updated_at bigint NOT NULL,
    PRIMARY KEY (place_id, id)
);

-- Characters (the old `players`). account_key is the canonical subject (usr_/gst_) for Network accounts
-- and 'guest:' + sha256hex(guest token) for local guests; the raw guest token is never stored. A lookup by
-- token hashes first (accountKey()).
CREATE TABLE characters (
    id          text COLLATE "C" PRIMARY KEY,
    account_key text COLLATE "C" NOT NULL,
    slot        integer NOT NULL,
    subject_id  text,
    name        text NOT NULL,
    place_id    text,
    pos_x       double precision NOT NULL,
    pos_y       double precision NOT NULL,
    pos_z       double precision NOT NULL,
    yaw         double precision NOT NULL,
    inventory   jsonb NOT NULL,
    skills      jsonb NOT NULL DEFAULT '{}',
    friends     jsonb NOT NULL DEFAULT '[]',
    appearance  jsonb,
    stats       jsonb,
    armor       jsonb,
    reputation  jsonb NOT NULL DEFAULT '{}',
    unlocks     jsonb NOT NULL DEFAULT '[]',
    active_job  text,
    updated_at  bigint NOT NULL
);
CREATE UNIQUE INDEX characters_account_slot ON characters (account_key, slot);
CREATE INDEX characters_subject ON characters (subject_id);

CREATE TABLE mods (
    id           text COLLATE "C" PRIMARY KEY,
    name         text NOT NULL,
    version      text NOT NULL,
    target       text NOT NULL,
    runtime      text NOT NULL,
    manifest     jsonb NOT NULL,
    pack         jsonb NOT NULL,
    trust_tier   text NOT NULL,
    status       text NOT NULL,
    installed_by text NOT NULL,
    installed_at bigint NOT NULL,
    updated_at   bigint NOT NULL
);

CREATE TABLE mod_grants (
    mod_id     text NOT NULL,
    capability text NOT NULL,
    granted_by text NOT NULL,
    granted_at bigint NOT NULL,
    revoked_at bigint,
    revoked_by text,
    PRIMARY KEY (mod_id, capability)
);

CREATE TABLE mod_placements (
    mod_id        text NOT NULL,
    placement_key text NOT NULL,
    entity_id     text,
    at            bigint NOT NULL,
    PRIMARY KEY (mod_id, placement_key)
);

CREATE TABLE mod_audit (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mod_id     text NOT NULL,
    action     text NOT NULL,
    capability text,
    actor      text NOT NULL,
    detail     jsonb,
    at         bigint NOT NULL
);
CREATE INDEX mod_audit_mod ON mod_audit (mod_id, id);

CREATE TABLE media_mirrors (
    asset_hash      text COLLATE "C" PRIMARY KEY,
    file_name       text NOT NULL,
    mime            text NOT NULL,
    bytes           integer NOT NULL,
    status          text NOT NULL,
    media_id        text,
    public_url      text,
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at bigint NOT NULL,
    updated_at      bigint NOT NULL
);
CREATE INDEX media_mirrors_due ON media_mirrors (status, next_attempt_at);

-- The once-only ledger guest conversion and account merge still use (adoption_key is the guest hash or
-- 'merge:<mergeId>'); it makes a redelivered event a no-op.
CREATE TABLE identity_adoptions (
    adoption_key text COLLATE "C" PRIMARY KEY,
    subject_id   text NOT NULL,
    source       text NOT NULL,
    moved        integer NOT NULL DEFAULT 0,
    conflicts    integer NOT NULL DEFAULT 0,
    adopted_at   bigint NOT NULL
);

-- Account export and deletion (ADR-033): one row per export/deletion network event, kept by the adapter.
CREATE TABLE account_data_events (
    id         text COLLATE "C" PRIMARY KEY,
    kind       text NOT NULL,
    subject    text NOT NULL,
    outcome    jsonb,
    sent_at    timestamptz,
    applied_at timestamptz NOT NULL DEFAULT now()
);

-- openvibe-sdk/events createPgOutbox: enqueue runs inside the caller's transaction, the relay claims due
-- rows with a lease.
CREATE TABLE event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;

-- openvibe-sdk/auth createPgRevocationStore: sign-out everywhere cutoffs, only ever moving forward.
CREATE TABLE token_revocations (
    subject_id     text COLLATE "C" PRIMARY KEY,
    valid_after_ms bigint NOT NULL,
    reason         text,
    updated_at     bigint NOT NULL
);

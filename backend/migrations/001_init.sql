CREATE TABLE IF NOT EXISTS players (
    steam_id              BIGINT PRIMARY KEY,
    display_name          TEXT NOT NULL,
    currency_balance      INTEGER NOT NULL DEFAULT 0 CHECK (currency_balance >= 0),
    xp                    INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
    equipped_model_id     TEXT,
    equipped_trail_id     TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_items (
    item_id       TEXT PRIMARY KEY,
    item_type     TEXT NOT NULL CHECK (item_type IN ('player_model', 'trail', 'nameplate')),
    display_name  TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    asset_path    TEXT NOT NULL,
    price         INTEGER NOT NULL CHECK (price >= 0),
    enabled       BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_items (
    steam_id      BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    item_id       TEXT NOT NULL REFERENCES shop_items(item_id) ON DELETE RESTRICT,
    acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (steam_id, item_id)
);

CREATE TABLE IF NOT EXISTS currency_ledger (
    ledger_id      BIGSERIAL PRIMARY KEY,
    steam_id       BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    delta          INTEGER NOT NULL,
    reason         TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (steam_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS game_servers (
    server_id       TEXT PRIMARY KEY,
    server_secret   TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('hub','prophunt','deathrun','fortwars','traitortown')),
    map_name        TEXT NOT NULL,
    public_host     TEXT NOT NULL,
    port            INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    max_players     INTEGER NOT NULL CHECK (max_players > 0),
    player_count    INTEGER NOT NULL DEFAULT 0 CHECK (player_count >= 0),
    state           TEXT NOT NULL CHECK (state IN ('starting','open','full','ending','offline')),
    last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS join_tokens (
    token          TEXT PRIMARY KEY,
    steam_id       BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    server_id      TEXT NOT NULL REFERENCES game_servers(server_id) ON DELETE CASCADE,
    mode           TEXT NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_results (
    result_id        BIGSERIAL PRIMARY KEY,
    match_id         TEXT NOT NULL,
    server_id        TEXT NOT NULL REFERENCES game_servers(server_id) ON DELETE RESTRICT,
    steam_id         BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    mode             TEXT NOT NULL,
    reward_currency  INTEGER NOT NULL CHECK (reward_currency >= 0),
    reward_xp        INTEGER NOT NULL CHECK (reward_xp >= 0),
    stats            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (match_id, steam_id)
);

CREATE TABLE IF NOT EXISTS parties (
    party_id          TEXT PRIMARY KEY,
    leader_steam_id   BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS party_members (
    party_id   TEXT NOT NULL REFERENCES parties(party_id) ON DELETE CASCADE,
    steam_id   BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (party_id, steam_id)
);

CREATE TABLE IF NOT EXISTS party_invites (
    invite_id           TEXT PRIMARY KEY,
    party_id            TEXT NOT NULL REFERENCES parties(party_id) ON DELETE CASCADE,
    invited_by_steam_id BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    invited_steam_id    BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    status              TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','expired')),
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
    audit_id        TEXT PRIMARY KEY,
    actor_steam_id  BIGINT NOT NULL,
    action          TEXT NOT NULL,
    target_steam_id BIGINT,
    reason          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_servers_open
ON game_servers (mode, state, player_count, last_heartbeat);

CREATE INDEX IF NOT EXISTS idx_join_tokens_valid
ON join_tokens (steam_id, server_id, expires_at)
WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_party_invites_invited
ON party_invites (invited_steam_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_created
ON audit_events (created_at DESC);

INSERT INTO shop_items (item_id, item_type, display_name, description, asset_path, price)
VALUES
    ('model_rebel', 'player_model', 'Rebel', 'Baseline resistance player model.', 'models/player/group03/male_07.mdl', 0),
    ('model_medic', 'player_model', 'Field Medic', 'A clean team-support look for hub and minigames.', 'models/player/group03m/male_07.mdl', 250),
    ('trail_blue', 'trail', 'Blue Trail', 'A simple blue movement trail.', 'particles/openvibe/trail_blue.pcf', 100),
    ('trail_gold', 'trail', 'Gold Trail', 'A warmer trail for event rewards and shop rotation.', 'particles/openvibe/trail_gold.pcf', 350),
    ('nameplate_founder', 'nameplate', 'Founder', 'Early OpenVibe identity plate.', 'ui/nameplates/founder', 500)
ON CONFLICT (item_id) DO NOTHING;

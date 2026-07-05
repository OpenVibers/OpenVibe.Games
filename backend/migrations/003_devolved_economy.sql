-- Devolved economy: item/crate/rare/registry definitions, slot-based player
-- inventory (flat ordered item ids, devolved-style), loadout/stats, and global
-- limited-item counters. Currency = players.currency_balance ("bucks"),
-- progression = players.xp (level derived with the devolved formula).

CREATE TABLE IF NOT EXISTS econ_defs (
    def_id        TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN
                    ('item','crate','rare','cade','perma','tier','roundbuy',
                     'specwep','taunt','mat','recipe','quest')),
    display_name  TEXT NOT NULL,
    icon          TEXT NOT NULL DEFAULT '',
    meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_econ_defs_kind ON econ_defs (kind) WHERE enabled;

CREATE TABLE IF NOT EXISTS econ_inventory (
    steam_id     BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    slot         INTEGER NOT NULL CHECK (slot >= 0 AND slot < 200),
    item_id      TEXT NOT NULL REFERENCES econ_defs(def_id) ON DELETE RESTRICT,
    acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (steam_id, slot)
);

CREATE TABLE IF NOT EXISTS econ_players (
    steam_id    BIGINT PRIMARY KEY REFERENCES players(steam_id) ON DELETE CASCADE,
    loadout     JSONB NOT NULL DEFAULT '{}'::jsonb,
    stats       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS econ_counters (
    counter_key  TEXT PRIMARY KEY,
    data         JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

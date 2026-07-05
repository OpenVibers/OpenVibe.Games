-- Devolved economy trading & market: server-wide bucks-priced market listings
-- (item escrowed into the listing while open) and direct player-to-player
-- trade offers (nothing escrowed; validated atomically at accept time).
-- Contract: docs/ECONOMY_TRADE_MARKET_API.md.

CREATE TABLE IF NOT EXISTS market_listings (
    listing_id       BIGSERIAL PRIMARY KEY,
    seller_steam_id  BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    item_id          TEXT NOT NULL REFERENCES econ_defs(def_id),
    price            INTEGER NOT NULL CHECK (price > 0),
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sold','cancelled')),
    sold_to          BIGINT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at      TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_market_listings_open
    ON market_listings (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_market_listings_seller_open
    ON market_listings (seller_steam_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS trade_offers (
    trade_id          BIGSERIAL PRIMARY KEY,
    from_steam_id     BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    to_steam_id       BIGINT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
    offer_item_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
    offer_bucks       INTEGER NOT NULL DEFAULT 0 CHECK (offer_bucks >= 0),
    request_item_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
    request_bucks     INTEGER NOT NULL DEFAULT 0 CHECK (request_bucks >= 0),
    message           TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','declined','cancelled')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at       TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_offers_to_open
    ON trade_offers (to_steam_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_trade_offers_from_open
    ON trade_offers (from_steam_id) WHERE status = 'open';

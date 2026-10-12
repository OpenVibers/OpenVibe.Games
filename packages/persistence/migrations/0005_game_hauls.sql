-- phase: expand
-- M6: Scraplandia "Haul" mode. One row per successful extraction; the haul leaderboard sums these.
CREATE TABLE game_hauls (
    account_key text COLLATE "C" NOT NULL,
    extraction_id text COLLATE "C" NOT NULL,
    player_name text NOT NULL,
    score integer NOT NULL CHECK (score > 0),
    finished_at bigint NOT NULL,
    PRIMARY KEY (account_key, extraction_id)
);
CREATE INDEX game_hauls_board ON game_hauls (finished_at, score DESC);

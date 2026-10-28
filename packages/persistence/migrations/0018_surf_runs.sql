-- phase: expand
-- OpenVibe.Surf Ride: server-derived time-trial runs. A run is authoritative
-- (the server simulated it); the client never supplies a time or position.
-- The track is a gzipped transform track for the ghost: positions at 1 cm
-- and yaw at 1/256 turn. `is_pb` marks the one personal best kept per
-- (map, account); the last five other runs are kept beside it, and the world
-- record is derived as MIN(time_ms) per map.
CREATE TABLE IF NOT EXISTS surf_runs (
    id            text COLLATE "C" PRIMARY KEY,
    map_id        text COLLATE "C" NOT NULL,
    account_key   text COLLATE "C" NOT NULL,
    player_name   text NOT NULL,
    time_ms       integer NOT NULL CHECK (time_ms >= 0),
    splits        jsonb NOT NULL,
    track         bytea NOT NULL,
    is_pb         boolean NOT NULL DEFAULT false,
    created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS surf_runs_board ON surf_runs (map_id, time_ms ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS surf_runs_player ON surf_runs (map_id, account_key, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS surf_runs_one_pb
    ON surf_runs (map_id, account_key) WHERE is_pb;

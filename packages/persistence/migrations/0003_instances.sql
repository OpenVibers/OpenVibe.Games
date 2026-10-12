-- phase: expand
-- A slot is stable across process restarts. A new holder increments the version;
-- writes from a former holder must check that version inside their transaction.
CREATE TABLE game_instances (
    place_id text NOT NULL REFERENCES places(id),
    slot integer NOT NULL CHECK (slot >= 0),
    id text COLLATE "C" NOT NULL,
    capacity integer NOT NULL CHECK (capacity > 0),
    state text NOT NULL CHECK (state IN ('starting', 'running', 'draining', 'stopped')),
    holder text COLLATE "C" NOT NULL,
    lease_version bigint NOT NULL DEFAULT 1,
    heartbeat_at bigint NOT NULL,
    lease_until bigint NOT NULL,
    PRIMARY KEY (place_id, slot),
    UNIQUE (id)
);
CREATE INDEX game_instances_live ON game_instances (place_id, state, lease_until);

-- A character keeps a last position in every instance it has visited. Its
-- inventory and progression remain one global character row.
CREATE TABLE character_instance_positions (
    character_id text COLLATE "C" NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    instance_id text COLLATE "C" NOT NULL REFERENCES game_instances(id),
    pos_x double precision NOT NULL,
    pos_y double precision NOT NULL,
    pos_z double precision NOT NULL,
    yaw double precision NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (character_id, instance_id)
);

-- phase: expand
-- Script state belongs to a mod in one place. Limits are enforced by the script host.
CREATE TABLE mod_storage (
    place_id text COLLATE "C" NOT NULL REFERENCES places(id),
    mod_id text COLLATE "C" NOT NULL,
    key text COLLATE "C" NOT NULL,
    value jsonb NOT NULL,
    PRIMARY KEY (place_id, mod_id, key)
);

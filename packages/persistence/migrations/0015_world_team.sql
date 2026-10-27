-- phase: expand
-- A creator world's team (owner, 2026-10-27: "make teams"): people its owner invited to build it with them. An editor
-- saves the world's map and scripts (the map's revision guards two saves at once, as it does for one person); the
-- owner keeps publishing, renaming, deleting and the team. An invite is a link: invite_hash is the sha-256 of its token,
-- good until invite_expires (ms) for anyone signed in, until the owner stops it or makes a new one.
CREATE TABLE IF NOT EXISTS creator_world_members (
    world_id  text COLLATE "C" NOT NULL REFERENCES creator_worlds(id) ON DELETE CASCADE,
    subject   text COLLATE "C" NOT NULL,
    name      text NOT NULL,
    added_at  bigint NOT NULL,
    PRIMARY KEY (world_id, subject)
);
CREATE INDEX IF NOT EXISTS creator_world_members_subject ON creator_world_members (subject);
ALTER TABLE creator_worlds ADD COLUMN IF NOT EXISTS invite_hash text COLLATE "C";
ALTER TABLE creator_worlds ADD COLUMN IF NOT EXISTS invite_expires bigint;
CREATE UNIQUE INDEX IF NOT EXISTS creator_worlds_invite ON creator_worlds (invite_hash) WHERE invite_hash IS NOT NULL;

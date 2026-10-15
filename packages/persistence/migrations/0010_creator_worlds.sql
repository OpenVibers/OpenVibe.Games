-- phase: expand
-- Creator worlds: a signed-in player's own place, built in /editor and published at /worlds. The map document is
-- the editor's v2 file (validated before it is stored); `revision` is its content hash, the editor's If-Match.
-- A world runs as the place 'world:<id>' (its rows in places/world_entities/... are removed with the world).
-- `status`: draft (only the owner sees it), published (listed and joinable), hidden (staff took it down; the
-- owner can still open it in the editor, nobody can join it).
CREATE TABLE creator_worlds (
    id            text COLLATE "C" PRIMARY KEY,
    owner_subject text COLLATE "C" NOT NULL,
    owner_name    text NOT NULL,
    title         text NOT NULL,
    summary       text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
    map           jsonb NOT NULL,
    revision      text COLLATE "C" NOT NULL,
    plays         integer NOT NULL DEFAULT 0,
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    published_at  bigint
);
CREATE INDEX creator_worlds_owner ON creator_worlds (owner_subject, updated_at DESC);
CREATE INDEX creator_worlds_listed ON creator_worlds (published_at DESC) WHERE status = 'published';

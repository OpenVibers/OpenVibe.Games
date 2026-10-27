-- phase: expand
-- The asset store (docs/platform-direction.md step 5, free first): builds (pieces placed in the editor, positions
-- relative to the build's origin) and scripts (one games-quickjs@1 mod) that creators publish for anyone to use in
-- their own worlds. `body` is checked before it is stored (the content package's creatorAssetOf). Published at once;
-- `hidden` is staff taking one down. `from_world` and `from_world_title` credit the world a build or script came
-- from, as it was then. A use is counted once per person (creator_asset_uses), never by the asset's own creator.
CREATE TABLE IF NOT EXISTS creator_assets (
    id                text COLLATE "C" PRIMARY KEY,
    owner_subject     text COLLATE "C" NOT NULL,
    owner_name        text NOT NULL,
    kind              text NOT NULL CHECK (kind IN ('prefab', 'script')),
    title             text NOT NULL,
    summary           text NOT NULL DEFAULT '',
    body              jsonb NOT NULL,
    status            text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
    uses              integer NOT NULL DEFAULT 0,
    from_world        text COLLATE "C",
    from_world_title  text,
    created_at        bigint NOT NULL,
    updated_at        bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS creator_assets_owner ON creator_assets (owner_subject, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_assets_listed ON creator_assets (created_at DESC, id) WHERE status = 'published';
CREATE TABLE IF NOT EXISTS creator_asset_uses (
    asset_id  text COLLATE "C" NOT NULL REFERENCES creator_assets(id) ON DELETE CASCADE,
    subject   text COLLATE "C" NOT NULL,
    used_at   bigint NOT NULL,
    PRIMARY KEY (asset_id, subject)
);
CREATE INDEX IF NOT EXISTS creator_asset_uses_subject ON creator_asset_uses (subject);

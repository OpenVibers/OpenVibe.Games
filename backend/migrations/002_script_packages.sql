-- 002_script_packages.sql
-- Adds script package registry tables and expands the shop_items item_type
-- constraint to include the new gamemode-cosmetic item types.
-- Apply after 001_init.sql.

-- Priority 10: expand shop_items item_type to include gamemode cosmetics.
ALTER TABLE shop_items
  DROP CONSTRAINT IF EXISTS shop_items_item_type_check;
ALTER TABLE shop_items
  ADD CONSTRAINT shop_items_item_type_check
  CHECK (item_type IN (
    'player_model', 'trail', 'nameplate',
    'title', 'spray', 'emote', 'fortwars_part', 'traitortown_cosmetic'
  ));

-- Priority 9: trusted script package registry.
-- Packages are admin-uploaded and must be explicitly enabled before the
-- runtime will load them.  Community uploads require a separate sandboxing
-- review step; only trusted=true packages are served.
CREATE TABLE IF NOT EXISTS script_packages (
    package_id    TEXT PRIMARY KEY,
    package_type  TEXT NOT NULL CHECK (package_type IN ('gamemode', 'addon', 'library')),
    display_name  TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    version       TEXT NOT NULL,
    author_steam_id BIGINT,
    manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    trusted       BOOLEAN NOT NULL DEFAULT false,
    enabled       BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS script_package_files (
    package_id  TEXT NOT NULL REFERENCES script_packages(package_id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
    realm       TEXT NOT NULL CHECK (realm IN ('server', 'client', 'shared')),
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (package_id, path)
);

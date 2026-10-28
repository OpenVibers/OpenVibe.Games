-- phase: expand
-- A surf place is named by its map id (`surf_lagoon`), the Source map-name form,
-- not the old hyphenated slug (`surf-lagoon`). The old rows move once, in
-- dependency order. There is at most one instance per place per slot; old and
-- canonical rows can both exist during a rolling deploy, so the canonical row
-- wins and the old one is dropped after its positions have moved.
INSERT INTO places (id, name) VALUES
    ('surf_lagoon', 'surf_lagoon'),
    ('surf_canyon', 'surf_canyon'),
    ('surf_orbit', 'surf_orbit')
ON CONFLICT (id) DO UPDATE SET name = excluded.name;

-- Keep the live lease of an old instance by copying it to the canonical place
-- id. The primary key is (place_id, slot); the id is `<place_id>:<slot>`.
INSERT INTO game_instances
    (place_id, slot, id, capacity, state, holder, lease_version, heartbeat_at, lease_until)
SELECT n.id, o.slot, n.id || ':' || o.slot, o.capacity, o.state, o.holder,
       o.lease_version, o.heartbeat_at, o.lease_until
FROM game_instances o
JOIN (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id) ON o.place_id = n.old_id
ON CONFLICT (place_id, slot) DO NOTHING;

-- A character that already has the canonical position keeps it; drop the
-- duplicate old row before moving the rest (the primary key is character+instance).
DELETE FROM character_instance_positions c
USING game_instances o, (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id), game_instances ni
WHERE c.instance_id = o.id
  AND o.place_id = n.old_id
  AND ni.place_id = n.id
  AND ni.slot = o.slot
  AND EXISTS (
    SELECT 1 FROM character_instance_positions x
    WHERE x.character_id = c.character_id AND x.instance_id = ni.id
  );

UPDATE character_instance_positions c
SET instance_id = ni.id
FROM game_instances o, (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id), game_instances ni
WHERE c.instance_id = o.id
  AND o.place_id = n.old_id
  AND ni.place_id = n.id
  AND ni.slot = o.slot;

DELETE FROM game_instances o
USING (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE o.place_id = n.old_id;

-- The character's last place is a plain label, not a foreign key.
UPDATE characters SET place_id = n.id
FROM (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE characters.place_id = n.old_id;

-- Per-place world state follows too. A key that already exists under the
-- canonical place wins; the old duplicate is dropped.
UPDATE world_meta m SET place_id = n.id
FROM (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE m.place_id = n.old_id
  AND NOT EXISTS (SELECT 1 FROM world_meta x WHERE x.place_id = n.id AND x.key = m.key);
DELETE FROM world_meta m USING (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE m.place_id = n.old_id;

UPDATE world_entities e SET place_id = n.id
FROM (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE e.place_id = n.old_id
  AND NOT EXISTS (SELECT 1 FROM world_entities x WHERE x.place_id = n.id AND x.id = e.id);
DELETE FROM world_entities e USING (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE e.place_id = n.old_id;

UPDATE world_constraints c SET place_id = n.id
FROM (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE c.place_id = n.old_id
  AND NOT EXISTS (SELECT 1 FROM world_constraints x WHERE x.place_id = n.id AND x.id = c.id);
DELETE FROM world_constraints c USING (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE c.place_id = n.old_id;

UPDATE mod_storage s SET place_id = n.id
FROM (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE s.place_id = n.old_id
  AND NOT EXISTS (
    SELECT 1 FROM mod_storage x
    WHERE x.place_id = n.id AND x.mod_id = s.mod_id AND x.key = s.key
  );
DELETE FROM mod_storage s USING (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE s.place_id = n.old_id;

-- Last: the old place rows themselves. Every reference above has moved.
DELETE FROM places p
USING (VALUES
    ('surf-lagoon', 'surf_lagoon'),
    ('surf-canyon', 'surf_canyon'),
    ('surf-orbit', 'surf_orbit')
) AS n(old_id, id)
WHERE p.id = n.old_id;

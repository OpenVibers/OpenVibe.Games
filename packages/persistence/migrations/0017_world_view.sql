-- phase: expand
-- How a creator world is seen (docs/platform-direction.md step 6, 2D): '3d' is the first-person view Scraplandia has;
-- 'top' looks straight down on the player (an orthographic, map-like 2D view: WASD moves on the screen, the mouse
-- aims). The world, its map, its server and its rules are the same either way; only the client's camera and controls
-- change. Remixes keep it.
ALTER TABLE creator_worlds ADD COLUMN IF NOT EXISTS view text NOT NULL DEFAULT '3d' CHECK (view IN ('3d', 'top'));

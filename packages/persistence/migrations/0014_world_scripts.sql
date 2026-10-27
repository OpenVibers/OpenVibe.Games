-- phase: expand
-- Scripts in a creator world (owner, 2026-10-27: "an open, moddable … game engine like Garry's mod, s&box or
-- Roblox"): the world's own games-quickjs@1 mods, as the content package validates them, run in its room's QuickJS
-- sandbox with the creator limits (docs/mods.md "Scripts in creator worlds"). An empty list for every world so far.
ALTER TABLE creator_worlds ADD COLUMN IF NOT EXISTS scripts jsonb NOT NULL DEFAULT '[]'::jsonb;

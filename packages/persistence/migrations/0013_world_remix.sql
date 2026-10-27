-- phase: expand
-- Remixing a creator world (owner, 2026-10-27: "other people can make games just like the same way you can copy our
-- game … it should be open"): a published world copied into a new draft of the remixer's own, credited.
-- remixed_from is the source's id with no foreign key: the source may be deleted later and the credit stays, with
-- the title and owner it had when it was copied. remixes counts how often a world was remixed by other people.
ALTER TABLE creator_worlds ADD COLUMN IF NOT EXISTS remixed_from text COLLATE "C";
ALTER TABLE creator_worlds ADD COLUMN IF NOT EXISTS remixed_from_title text;
ALTER TABLE creator_worlds ADD COLUMN IF NOT EXISTS remixed_from_owner text;
ALTER TABLE creator_worlds ADD COLUMN IF NOT EXISTS remixes integer NOT NULL DEFAULT 0;

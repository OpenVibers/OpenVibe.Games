-- phase: expand
-- M5: Inventory delivery state for earned achievement items.
ALTER TABLE game_achievements
    ADD COLUMN item_state text CHECK (item_state IN ('granted', 'failed')),
    ADD COLUMN item_error text,
    ADD COLUMN item_instance text,
    ADD COLUMN item_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN item_updated_at bigint;
CREATE INDEX game_achievements_items_due ON game_achievements (item_state, unlocked_at)
    WHERE account_key LIKE 'usr_%' AND item_state IS DISTINCT FROM 'granted';

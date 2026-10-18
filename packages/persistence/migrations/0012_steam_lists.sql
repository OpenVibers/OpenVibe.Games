-- phase: expand
-- The Steam section (/steam): Steam's featured lists as OpenVibe.Sources last saw them (category games, contracts
-- 0.205.0; sources steam-top-sellers, steam-new-releases, steam-specials). Each sync replaces a list's rows with the
-- games its source saw in the last 7 hours, in the store's order; prices are in the currency's minor unit (cents).
CREATE TABLE steam_list_entries (
    list             text COLLATE "C" NOT NULL,   -- top | new | sale
    appid            integer NOT NULL,
    position         integer NOT NULL,            -- 0-based, the store's order
    name             text NOT NULL,
    final_price      integer,                     -- null when the store states none
    original_price   integer,
    discount_percent integer NOT NULL DEFAULT 0,
    currency         text COLLATE "C",
    header_image     text,
    windows          boolean NOT NULL DEFAULT false,
    mac              boolean NOT NULL DEFAULT false,
    linux            boolean NOT NULL DEFAULT false,
    discount_ends_at bigint,                      -- epoch ms
    observed_at      bigint NOT NULL,             -- epoch ms: when Sources last saw it in the list
    PRIMARY KEY (list, appid)
);

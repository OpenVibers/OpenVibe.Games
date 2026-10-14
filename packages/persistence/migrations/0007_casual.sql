-- phase: expand
-- T22: the casual kit. One save per player per casual game (the server-owned PlayerState), the ledger of every
-- currency and item change, and the idempotency record of every applied action.
CREATE TABLE casual_saves (
    game_id text COLLATE "C" NOT NULL,
    account_key text COLLATE "C" NOT NULL,
    state jsonb NOT NULL,
    version integer NOT NULL DEFAULT 0,
    player_name text,
    stage integer NOT NULL DEFAULT 0,
    power integer NOT NULL DEFAULT 0,
    -- Where the player first came from (an ad link's src and c), first-party only.
    source text,
    campaign text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (game_id, account_key)
);
CREATE INDEX casual_saves_board ON casual_saves (game_id, stage DESC, power DESC, updated_at);
CREATE INDEX casual_saves_account ON casual_saves (account_key);

CREATE TABLE casual_ledger (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    game_id text COLLATE "C" NOT NULL,
    account_key text COLLATE "C" NOT NULL,
    action_key text COLLATE "C" NOT NULL,
    asset text COLLATE "C" NOT NULL,
    delta bigint NOT NULL,
    balance bigint NOT NULL,
    reason text NOT NULL,
    at bigint NOT NULL
);
CREATE INDEX casual_ledger_account ON casual_ledger (game_id, account_key, id);

CREATE TABLE casual_actions (
    game_id text COLLATE "C" NOT NULL,
    account_key text COLLATE "C" NOT NULL,
    action_key text COLLATE "C" NOT NULL,
    response jsonb NOT NULL,
    at bigint NOT NULL,
    PRIMARY KEY (game_id, account_key, action_key)
);
CREATE INDEX casual_actions_age ON casual_actions (at);

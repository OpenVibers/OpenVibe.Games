-- phase: expand
-- M5: round results are the sole score source. The best score is derived from them.
CREATE TABLE game_round_results (
    game_id text COLLATE "C" NOT NULL,
    round_id text COLLATE "C" NOT NULL,
    account_key text COLLATE "C" NOT NULL,
    player_name text NOT NULL,
    score integer NOT NULL CHECK (score >= 0),
    rank integer NOT NULL CHECK (rank > 0),
    finished_at bigint NOT NULL,
    PRIMARY KEY (game_id, round_id, account_key)
);
CREATE INDEX game_round_results_board ON game_round_results (game_id, finished_at, score DESC);

CREATE TABLE game_best_scores (
    game_id text COLLATE "C" NOT NULL,
    account_key text COLLATE "C" NOT NULL,
    player_name text NOT NULL,
    score integer NOT NULL CHECK (score >= 0),
    finished_at bigint NOT NULL,
    PRIMARY KEY (game_id, account_key)
);
CREATE INDEX game_best_scores_board ON game_best_scores (game_id, score DESC, finished_at ASC);

CREATE TABLE game_achievements (
    game_id text COLLATE "C" NOT NULL,
    achievement_id text COLLATE "C" NOT NULL,
    account_key text COLLATE "C" NOT NULL,
    unlocked_at bigint NOT NULL,
    PRIMARY KEY (game_id, achievement_id, account_key)
);
CREATE INDEX game_achievements_player ON game_achievements (account_key, game_id);

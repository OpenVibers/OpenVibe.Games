-- phase: expand
-- ADR-0007 decision 10 (OpenVibe.Play): how far Games has posted each local stream (rounds, hauls, unlocks, adoptions)
-- to Play. A keyset position: the last row's time and its key; the sync moves it only past what Play accepted.
CREATE TABLE play_sync (
    stream text COLLATE "C" PRIMARY KEY,
    at bigint NOT NULL,
    key text COLLATE "C" NOT NULL
);

-- phase: expand
-- Creator worlds in OpenVibe.Search (openvibe-publishing/search-feed, contracts 0.195.0): the index sequencer, the
-- last revision and content hash sent for each document (owner games, type world). The events go out through the
-- existing event_outbox, in the transaction of the change they describe.
CREATE TABLE games_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);

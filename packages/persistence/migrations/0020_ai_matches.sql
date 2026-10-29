-- phase: expand
CREATE TABLE ai_matches (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('running', 'submitting', 'complete', 'failed')),
  result jsonb,
  bench jsonb,
  error text
);
CREATE INDEX ai_matches_daily ON ai_matches (created_at);

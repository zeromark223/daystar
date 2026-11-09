-- Load test runs and their measured rows (tools/loadtest.ts), next to the CSV
-- files, so runs from any machine can be compared in one place.

CREATE TABLE loadtest_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The web UI's run name; null from the command line.
  name            text,
  command         text NOT NULL,
  target          text NOT NULL,
  -- The server's runtime as /api/health reports it, e.g. "bun 1.4.2".
  runtime         text,
  -- The machine running the bots.
  host            text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  -- running until it ends; a run still "running" long after started died with its process.
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'stopped', 'failed')),
  summary         text,
  -- Highest bot count meeting every target, and the first failing one.
  max_ok_bots     integer,
  first_fail_bots integer
);
CREATE INDEX loadtest_runs_started ON loadtest_runs (started_at DESC);

-- One row per measured row of the run: the CSV's columns in `metrics` (same
-- names, e.g. metrics->>'loop_p99_ms'), the ones you filter on as columns.
CREATE TABLE loadtest_rows (
  run_id  bigint NOT NULL REFERENCES loadtest_runs (id) ON DELETE CASCADE,
  seq     integer NOT NULL,
  at      timestamptz NOT NULL DEFAULT now(),
  time_s  integer NOT NULL,
  bots    integer NOT NULL,
  ok      boolean NOT NULL,
  verdict text NOT NULL,
  metrics jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Background work (scheduled status changes, exports): a table, not a message broker. Workers take a job with
-- SELECT ... FOR UPDATE SKIP LOCKED, so several server instances can share the queue.
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  run_after   timestamptz NOT NULL DEFAULT now(),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);
CREATE INDEX jobs_ready_idx ON jobs (run_after) WHERE status = 'queued';

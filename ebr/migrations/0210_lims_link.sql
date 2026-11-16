-- The link to the LIMS (E18): one row per sample request a batch sent, keyed by a reference that makes a retry safe.
CREATE TABLE lims_requests (
  external_ref    text PRIMARY KEY,
  batch_id        uuid NOT NULL REFERENCES batches(id),
  step_key        text NOT NULL,
  lims_sample_id  text NOT NULL,
  test            text NOT NULL,
  status          text NOT NULL DEFAULT 'requested',
  result          jsonb,
  result_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lims_requests_batch_idx ON lims_requests (batch_id);

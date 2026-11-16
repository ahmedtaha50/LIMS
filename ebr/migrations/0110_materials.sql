-- Materials and their lots (E12). A lot is used in a batch only when QA has released it and it is not expired.
CREATE TABLE materials (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  unit        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE material_lots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_code  text NOT NULL REFERENCES materials(code),
  lot_number     text NOT NULL,
  status         text NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine', 'released', 'rejected')),
  expiry_date    date NOT NULL,
  created_by     text NOT NULL,
  decided_by     text,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX material_lots_key ON material_lots (material_code, lower(lot_number));

-- Yield and material reconciliation of a batch, once, signed (E12#3).
CREATE TABLE batch_reconciliations (
  batch_id         uuid PRIMARY KEY REFERENCES batches(id),
  output_quantity  numeric NOT NULL,
  unit             text NOT NULL,
  theoretical      numeric NOT NULL,
  yield_pct        numeric NOT NULL,
  materials        jsonb NOT NULL,
  recorded_by      text NOT NULL,
  recorded_at      timestamptz NOT NULL,
  signature_id     bigint NOT NULL REFERENCES signatures(id)
);

-- An exception raised by the reconciliation of a whole batch belongs to no single step (E12#3).
ALTER TABLE batch_exceptions ALTER COLUMN step_id DROP NOT NULL;

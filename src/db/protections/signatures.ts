// Append-only electronic signatures. Moved out of src/db/protections.ts by r1-migrations; r1-esign owns this file.
import { appendOnlyTable, type ProtectionSet } from './common';

export const signatureProtections: ProtectionSet = {
  domain: 'signatures',
  statements: [
    // signRecord (src/server/esign) writes the audit entry first and inserts the signature with its final audit_entry_id. The routes that
    // have not moved to it insert audit_entry_id = 'pending' and link it once, in the same transaction; that single link is the only
    // update allowed, and since migration 0020 it still requires every other column, the new binding and snapshot columns included, to be equal.
    `CREATE OR REPLACE FUNCTION gxp_signature_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.audit_entry_id = 'pending' AND NEW.audit_entry_id <> 'pending'
         AND (to_jsonb(NEW) - 'audit_entry_id') = (to_jsonb(OLD) - 'audit_entry_id') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'GxP: % on signatures is not permitted (append-only record)', TG_OP
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql`,
    ...appendOnlyTable('signatures', 'gxp_signature_guard'),
  ],
};

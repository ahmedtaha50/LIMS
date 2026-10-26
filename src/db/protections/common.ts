/**
 * Building blocks for the database-level immutability controls (21 CFR Part 11.10(e)).
 * A domain file in this folder exports a ProtectionSet; src/db/protections.ts lists the sets and installs them.
 */
export interface ProtectionSet {
  /** The domain that owns the statements (audit, signatures, ops, ...). */
  domain: string;
  /** Idempotent SQL, executed in order; functions before the triggers that use them. */
  statements: string[];
}

/** Refuses every UPDATE, DELETE and TRUNCATE it is attached to. Shared by all append-only tables. */
export const blockMutation: ProtectionSet = {
  domain: 'common',
  statements: [
    `CREATE OR REPLACE FUNCTION gxp_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'GxP: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql`,
  ],
};

/**
 * Trigger names are gxp_<table>_row_guard and gxp_<table>_truncate_guard; tests/backup-restore.sh counts triggers named gxp_%.
 * `rowFunction` is the trigger function for UPDATE/DELETE (default: refuse always); TRUNCATE is always refused.
 */
export function appendOnlyTable(table: string, rowFunction = 'gxp_block_mutation'): string[] {
  return [
    `DROP TRIGGER IF EXISTS gxp_${table}_row_guard ON ${table}`,
    `CREATE TRIGGER gxp_${table}_row_guard BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${rowFunction}()`,
    `DROP TRIGGER IF EXISTS gxp_${table}_truncate_guard ON ${table}`,
    `CREATE TRIGGER gxp_${table}_truncate_guard BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION gxp_block_mutation()`,
  ];
}

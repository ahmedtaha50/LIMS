// Controlled documents. Owned by r2-coa-reports (migration 0190_coa_reports, roadmap M25).
//   coa_documents      a certificate changes only as a controlled document may: Issued -> Superseded | Voided with its reason, the original
//                      PDF hash recorded once, never deleted (gxp_coa_documents_guard). Its number, version, snapshot and authorisation
//                      never change.
//   report_runs        append-only: every generated document with its bytes and their sha256.
//   report_print_log   append-only: every delivery of a run's bytes.
// The migration creates the same function and triggers (tests/api/coa-reports-migration.test.ts checks the text is the same), so a
// schema built from the migrations alone is guarded too.
import { appendOnlyTable, type ProtectionSet } from './common';

/** The row guard of coa_documents: the exact text of drizzle/0190_coa_reports.sql. */
export const COA_DOCUMENTS_GUARD = `CREATE OR REPLACE FUNCTION gxp_coa_documents_guard() RETURNS trigger AS $$
    DECLARE problem text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        problem := 'a certificate is never deleted (void it instead)';
      ELSIF ROW(NEW.id, NEW.sample_id, NEW.number, NEW.issue_version, NEW.label, NEW.spec_id, NEW.spec_revision, NEW.snapshot,
                NEW.snapshot_sha256, NEW.issued_by, NEW.issued_at, NEW.supersedes_id, NEW.created_at)
            IS DISTINCT FROM
            ROW(OLD.id, OLD.sample_id, OLD.number, OLD.issue_version, OLD.label, OLD.spec_id, OLD.spec_revision, OLD.snapshot,
                OLD.snapshot_sha256, OLD.issued_by, OLD.issued_at, OLD.supersedes_id, OLD.created_at) THEN
        problem := 'the number, version, sample, specification, snapshot and authorisation of a certificate never change';
      ELSIF OLD.pdf_sha256 IS NOT NULL AND ROW(NEW.pdf_sha256, NEW.original_run_id) IS DISTINCT FROM ROW(OLD.pdf_sha256, OLD.original_run_id) THEN
        problem := 'the original PDF of a certificate is recorded once';
      ELSIF OLD.status <> 'Issued' AND NEW.status <> OLD.status THEN
        problem := format('a %s certificate stays %s', OLD.status, OLD.status);
      ELSIF ROW(OLD.superseded_by_id, OLD.superseded_by, OLD.superseded_at, OLD.superseded_reason) IS DISTINCT FROM ROW(NULL::text, NULL::text, NULL::timestamptz, NULL::text)
            AND ROW(NEW.superseded_by_id, NEW.superseded_by, NEW.superseded_at, NEW.superseded_reason) IS DISTINCT FROM ROW(OLD.superseded_by_id, OLD.superseded_by, OLD.superseded_at, OLD.superseded_reason) THEN
        problem := 'the supersede record of a certificate never changes';
      ELSIF ROW(OLD.voided_by, OLD.voided_at, OLD.void_reason) IS DISTINCT FROM ROW(NULL::text, NULL::timestamptz, NULL::text)
            AND ROW(NEW.voided_by, NEW.voided_at, NEW.void_reason) IS DISTINCT FROM ROW(OLD.voided_by, OLD.voided_at, OLD.void_reason) THEN
        problem := 'the void record of a certificate never changes';
      ELSIF NEW.status = 'Superseded' AND (NEW.superseded_by_id IS NULL OR NEW.superseded_by IS NULL OR NEW.superseded_at IS NULL OR coalesce(btrim(NEW.superseded_reason), '') = '') THEN
        problem := 'a superseded certificate names its successor, who superseded it, when and why';
      ELSIF NEW.status = 'Voided' AND (NEW.voided_by IS NULL OR NEW.voided_at IS NULL OR coalesce(btrim(NEW.void_reason), '') = '') THEN
        problem := 'a voided certificate names who voided it, when and why';
      ELSIF NEW.status <> 'Superseded' AND ROW(NEW.superseded_by_id, NEW.superseded_by, NEW.superseded_at, NEW.superseded_reason) IS DISTINCT FROM ROW(NULL::text, NULL::text, NULL::timestamptz, NULL::text) THEN
        problem := 'only a superseded certificate has a supersede record';
      ELSIF NEW.status <> 'Voided' AND ROW(NEW.voided_by, NEW.voided_at, NEW.void_reason) IS DISTINCT FROM ROW(NULL::text, NULL::timestamptz, NULL::text) THEN
        problem := 'only a voided certificate has a void record';
      END IF;
      IF problem IS NOT NULL THEN
        RAISE EXCEPTION 'GxP: % on coa_documents is not permitted (controlled document): %', TG_OP, problem
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`;

/** Skipped while the table does not exist: a backup of an older version is restored into that version's schema (see ./ops.ts). */
const whenTableExists = (table: string, rowFunction?: string): string =>
  `DO $guard$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ${appendOnlyTable(table, rowFunction).join('; ')}; END IF; END $guard$`;

export const reportsProtections: ProtectionSet = {
  domain: 'reports',
  statements: [
    COA_DOCUMENTS_GUARD,
    whenTableExists('coa_documents', 'gxp_coa_documents_guard'),
    whenTableExists('report_runs'),
    whenTableExists('report_print_log'),
  ],
};

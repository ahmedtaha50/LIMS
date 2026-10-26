/**
 * The permission catalog and the default role matrix (roadmap M09). Shared by the server and the client, so it imports nothing.
 *
 * What a user may do is decided by ONE thing: the permission codes held by their role. Every API route is bound to one code in
 * src/server/authz/routeTable.ts; the screen asks `hasPermission(me.permissions, 'spec.approve')` instead of comparing role names.
 *
 * This file is the source of the rows migration drizzle/0040_authz.sql installs (scripts/authz/generate-seed.ts prints them) and
 * tests/api/authz-matrix.test.ts fails when the migrated tables and this catalog differ. To change the matrix: edit this file AND
 * add a migration (a new drizzle/004N file that inserts or deletes role_permissions rows). That is a change-control event
 * (Annex 11 s.10): the migration journal and the SCHEMA_MIGRATED audit entry are its record. docs/permission-matrix.csv is the
 * review copy (`npx tsx scripts/authz/export-matrix.ts`).
 *
 * Default matrix = what the handlers enforced before this change, with ONE tightening: approving a specification
 * (`spec.approve`) is limited to Admin and QA, like the other approvals (closing an OOS investigation, releasing a batch).
 * Everything the handlers left open stays open to the roles that could do it, until QA decides otherwise.
 */

export const ROLE_NAMES = ['Admin', 'QA', 'Reviewer', 'Analyst'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Roles whose grant (or removal) needs the independent second signature of the role-change flow. */
export const ROLES_REQUIRING_APPROVAL: readonly RoleName[] = ['Admin', 'QA'];

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  Admin: 'System administration: accounts, security policy, integrations, backup. Holds every permission.',
  QA: 'Quality assurance: approvals, release, audit review, training certification.',
  Reviewer: 'Independent review of analytical results.',
  Analyst: 'Bench work: registering samples, entering results, notebook and records.',
};

interface P { code: string; category: string; description: string }

export const PERMISSIONS = [
  // Samples and results
  { code: 'sample.view', category: 'Samples', description: 'Read samples, their results, signatures and notebook' },
  { code: 'sample.register', category: 'Samples', description: 'Register a sample, or import several' },
  { code: 'sample.transition', category: 'Samples', description: 'Move a sample through submit, review, approve or reject (the allowed roles of each step are enforced by the workflow)' },
  { code: 'sample.notebook.add', category: 'Samples', description: 'Add a signed observation to a sample notebook' },
  { code: 'result.enter', category: 'Samples', description: 'Enter or correct a result value' },
  // Out-of-specification investigations
  { code: 'oos.view', category: 'OOS', description: 'Read OOS investigations' },
  { code: 'oos.open', category: 'OOS', description: 'Open an OOS investigation' },
  { code: 'oos.edit', category: 'OOS', description: 'Edit an open OOS investigation (root cause, assignee)' },
  { code: 'oos.close', category: 'OOS', description: 'Close an OOS investigation with an e-signature' },
  // Specifications
  { code: 'spec.view', category: 'Specifications', description: 'Read specifications' },
  { code: 'spec.create', category: 'Specifications', description: 'Create a draft specification' },
  { code: 'spec.edit', category: 'Specifications', description: 'Edit the parameters of a draft specification' },
  { code: 'spec.approve', category: 'Specifications', description: 'Approve a specification for use (master data approval; never the author)' },
  // Batch records and traceability
  { code: 'trace.view', category: 'Batch records', description: 'Read batch traceability dossiers' },
  { code: 'trace.dispense', category: 'Batch records', description: 'Record a dispensed raw material on a batch' },
  { code: 'batch.release', category: 'Batch records', description: 'Authorise batch release with an e-signature' },
  { code: 'record.verify', category: 'Batch records', description: 'Verify signatures and the audit chain of a record' },
  // Laboratory notebook
  { code: 'eln.view', category: 'Notebook', description: 'Read notebook worksheets and templates' },
  { code: 'eln.create', category: 'Notebook', description: 'Create a worksheet or a template' },
  { code: 'eln.edit', category: 'Notebook', description: 'Edit an unsigned worksheet' },
  { code: 'eln.sign', category: 'Notebook', description: 'Sign and lock a worksheet' },
  // Equipment, reagents, monitoring, stability
  { code: 'instrument.view', category: 'Equipment', description: 'Read instruments' },
  { code: 'instrument.register', category: 'Equipment', description: 'Register an instrument' },
  { code: 'instrument.calibrate', category: 'Equipment', description: 'Record a calibration' },
  { code: 'reagent.view', category: 'Equipment', description: 'Read reagents' },
  { code: 'reagent.receive', category: 'Equipment', description: 'Receive a reagent into stock' },
  { code: 'env.view', category: 'Environmental', description: 'Read environmental monitoring records' },
  { code: 'env.record', category: 'Environmental', description: 'Record an environmental monitoring result' },
  { code: 'env.edit', category: 'Environmental', description: 'Correct an environmental monitoring record' },
  { code: 'stability.view', category: 'Stability', description: 'Read stability studies' },
  { code: 'stability.create', category: 'Stability', description: 'Create a stability study' },
  { code: 'stability.edit', category: 'Stability', description: 'Edit a stability study' },
  // Reports
  { code: 'report.view', category: 'Reports', description: 'Read the dashboard, batch reports, trends and metrics' },
  { code: 'report.generate', category: 'Reports', description: 'Request a results preview or a controlled copy of an issued certificate, and collect it' },
  // Training and AI
  { code: 'training.view', category: 'Training', description: 'Read the training matrix' },
  { code: 'training.certify', category: 'Training', description: 'Certify another user as trained in the software' },
  { code: 'ai.use', category: 'AI', description: 'Use the AI assistance (off unless an Administrator enabled it)' },
  // Audit and security
  { code: 'audit.view', category: 'Audit', description: 'Read the audit trail and its head' },
  { code: 'audit.verify', category: 'Audit', description: 'Verify the audit chain' },
  { code: 'audit.export', category: 'Audit', description: 'Export the audit trail' },
  { code: 'audit.history.view', category: 'Audit', description: 'Read the change history of a record' },
  { code: 'security.view', category: 'Audit', description: 'Read security events' },
  { code: 'security.verify', category: 'Audit', description: 'Verify the security-event chain' },
  // Administration
  { code: 'admin.users.view', category: 'Administration', description: 'List user accounts' },
  { code: 'admin.users.manage', category: 'Administration', description: 'Create, deactivate and reset accounts' },
  { code: 'admin.settings.view', category: 'Administration', description: 'Read the security policies' },
  { code: 'admin.settings.manage', category: 'Administration', description: 'Change the security policies' },
  { code: 'admin.integrations.view', category: 'Administration', description: 'Read the external integration settings' },
  { code: 'admin.integrations.manage', category: 'Administration', description: 'Change the external integration settings' },
  { code: 'admin.broadcast', category: 'Administration', description: 'Send a system-wide alert' },
  { code: 'admin.activity.view', category: 'Administration', description: 'Read the usage heat-map' },
  { code: 'admin.backup.run', category: 'Administration', description: 'Make, verify and drill backups' },
  { code: 'admin.backup.view', category: 'Administration', description: 'Read the backup status' },
  { code: 'admin.jobs.view', category: 'Administration', description: 'Read the job queue and the scheduler' },
  { code: 'system.info.view', category: 'Administration', description: 'Read the version and schema information' },
  // Authorisation
  { code: 'authz.view', category: 'Authorisation', description: 'Read the permission matrix and the role-change requests' },
  { code: 'authz.role.request', category: 'Authorisation', description: 'Request a change of a user role (first signature)' },
  { code: 'authz.role.approve', category: 'Authorisation', description: 'Approve or reject a requested role change (second, independent signature)' },

  // r2-master-data (migration 0100_master_data, positions 59 to 61)
  { code: 'master.view', category: 'Master data', description: 'Read products, batches and customers' },
  { code: 'master.manage', category: 'Master data', description: 'Create and edit products, batches and customers' },
  { code: 'master.status', category: 'Master data', description: 'Change the status of a product or a batch with an e-signature' },

  // r2-methods-calc (migration 0110_methods_calc, positions 62 to 64)
  { code: 'method.view', category: 'Methods', description: 'Read methods, calculation formulas, test plans and system suitability runs' },
  { code: 'method.manage', category: 'Methods', description: 'Draft and edit methods, calculation formulas and test plans' },
  { code: 'method.approve', category: 'Methods', description: 'Approve a method, a calculation formula or a test plan for use (never the author)' },

  // r2-audit-tamper (migration 0170_audit_review, positions 170 to 172)
  { code: 'audit.review', category: 'Audit', description: 'Sign an audit trail review of a batch or of a range of entries' },
  { code: 'audit.review.settings', category: 'Audit', description: 'Switch the audit-trail-review-before-release requirement on or off with an e-signature' },
  { code: 'clock.acknowledge', category: 'Audit', description: 'Acknowledge a clock anomaly with an e-signature, which lifts the signing block' },
  // r2-qms (migration 0180_qms, positions 180 to 184)
  { code: 'qms.view', category: 'Quality management', description: 'Read deviations, CAPA, change controls and audit findings' },
  { code: 'qms.create', category: 'Quality management', description: 'Raise a deviation, CAPA, change control or audit finding' },
  { code: 'qms.edit', category: 'Quality management', description: 'Edit an open quality record, move it through its unsigned steps, add actions, links and comments' },
  { code: 'qms.approve', category: 'Quality management', description: 'Triage, approve, close or reject a quality record with an e-signature; verify effectiveness' },
  { code: 'qms.settings', category: 'Quality management', description: 'Switch the change-control requirement on or off with an e-signature' },

  // r2-coa-reports (migration 0190_coa_reports, position 190)
  { code: 'coa.issue', category: 'Reports', description: 'Issue, re-issue or void a Certificate of Analysis with an e-signature (never someone who tested the sample)' },

  // r2-raw-data (migration 0120_raw_data, position 120)
  { code: 'result.reintegration.approve', category: 'Samples', description: 'Approve a reintegrated result with an e-signature (never the person who reintegrated it)' },

  // r2-docs-training (migration 0200_docs_training, positions 200 to 207)
  { code: 'doc.view', category: 'Documents', description: 'Read controlled documents, their versions and files' },
  { code: 'doc.author', category: 'Documents', description: 'Draft a controlled document or a new revision, and submit it for review with an authorship signature' },
  { code: 'doc.review', category: 'Documents', description: 'Review a submitted document version with an e-signature, or return it to Draft' },
  { code: 'doc.approve', category: 'Documents', description: 'Approve a reviewed document version, make it effective (QA) or withdraw it, with an e-signature' },
  { code: 'doc.print', category: 'Documents', description: 'Print a numbered controlled copy of an effective document (print log)' },
  { code: 'training.manage', category: 'Training', description: 'Define curricula and assign training' },
  { code: 'training.acknowledge', category: 'Training', description: 'Sign one\'s own training assignment as read and understood' },
  { code: 'training.override', category: 'Training', description: 'Authorise a time-limited qualification override for an analyst with an e-signature' },

  // r2-oos-workflow (migration 0210_oos_workflow, positions 210-211)
  { code: 'oos.approve', category: 'OOS', description: 'Confirm an assignable cause (invalidate an OOS result) and authorise retests with an e-signature' },
  { code: 'oos.settings', category: 'OOS', description: 'Change the OOS retest and due-date rules with an e-signature; add checklist templates' },

  // r2-em (migration 0250_em, positions 250-251)
  { code: 'env.manage', category: 'Environmental', description: 'Maintain sampling points, batch room windows and limit profiles (approval with an e-signature); acknowledge adverse trends' },
  { code: 'env.correct', category: 'Environmental', description: 'Correct a recorded environmental monitoring result, with a reason' },

  // r2-stability (migration 0240_stability, positions 240-241)
  { code: 'stability.manage', category: 'Stability', description: 'Draft and revise stability protocols; maintain storage conditions and chambers' },
  { code: 'stability.approve', category: 'Stability', description: 'Approve a stability protocol revision with an e-signature' },

  // r2-instrument-integration (migration 0260_instrument_data, positions 260 and 261)
  { code: 'instrument.profile.manage', category: 'Equipment', description: 'Define and edit the capture profiles of instruments (folder, parser, mapping); an edit of an approved profile needs a new approval' },
  { code: 'instrument.profile.approve', category: 'Equipment', description: 'Approve a capture profile with an e-signature (never the person who wrote or last edited it)' },

  // r2-reagents (migration 0230_reagents, positions 230 to 232)
  { code: 'reagent.manage', category: 'Equipment', description: 'Define and edit reagent and reference standard items (the item master)' },
  { code: 'reagent.use', category: 'Equipment', description: 'Open a released lot, record consumption, prepare and discard solutions, and record the lots used for a result' },
  { code: 'reagent.approve', category: 'Equipment', description: 'Release a received lot from quarantine, reject it or record its retest, with an e-signature (never the receiver)' },

  // r2-custody-labels (migration 0220_custody, positions 220-224)
  { code: 'custody.view', category: 'Custody', description: 'Read sample receipts, containers, the custody ledger, storage locations, the retain register and the label log' },
  { code: 'custody.handle', category: 'Custody', description: 'Record a sample receipt, make aliquots, transfer, consume and register retains' },
  { code: 'custody.locations', category: 'Custody', description: 'Define and change storage locations' },
  { code: 'custody.approve', category: 'Custody', description: 'Acknowledge a receipt deviation and dispose of a retained sample with an e-signature' },
  { code: 'label.print', category: 'Custody', description: 'Print sample, container and location labels (a reprint needs a reason)' },

  // r2-worklists (migration 0270_worklists, positions 270-271)
  { code: 'worklist.view', category: 'Worklists', description: 'Read worklists, the workload view and the run-sequence export' },
  { code: 'worklist.manage', category: 'Worklists', description: 'Plan, release, change, complete and cancel worklists; assign analysts; request the bench sheet' },
  // r2-validation (migration 0300_qualified_modules, positions 300-301)
  { code: 'validation.view', category: 'Validation', description: 'Read the validated-scope register (which modules are qualified)' },
  { code: 'validation.scope', category: 'Validation', description: 'Declare a module Qualified or NotQualified with an e-signature' },
  // r3-directory (migration 0310_directory, positions 310-312)
  { code: 'directory.view', category: 'Directory', description: 'Read the directory sign-on settings, group mappings and directory accounts' },
  { code: 'directory.manage', category: 'Directory', description: 'Change the directory connection, propose group mappings, flag break-glass accounts and test the connection' },
  { code: 'directory.approve', category: 'Directory', description: 'Approve or retire a directory group to role mapping with an e-signature' },
  // r3-spc (migration 0320_spc, positions 320-321)
  { code: 'spc.view', category: 'Trending', description: 'Read control charts, baselines, out-of-trend alerts and shelf-life estimates' },
  { code: 'spc.manage', category: 'Trending', description: 'Set a control-limit baseline (e-signed), evaluate and acknowledge out-of-trend alerts' },
  // r3-periodic-archive (migration 0330_periodic_archive, positions 330-335)
  { code: 'periodic.view', category: 'Periodic review', description: 'Read periodic review plans, reviews and their evidence' },
  { code: 'periodic.manage', category: 'Periodic review', description: 'Create review plans, open reviews and record findings' },
  { code: 'periodic.sign', category: 'Periodic review', description: 'Complete a periodic review with an e-signature' },
  { code: 'archive.view', category: 'Archive', description: 'Read the archive register, retention policies and legal holds' },
  { code: 'archive.manage', category: 'Archive', description: 'Build, verify and restore-test archive bundles; decide the archive with an e-signature' },
  { code: 'retention.manage', category: 'Archive', description: 'Set retention periods, place and release legal holds, flag archived records for disposal review' },
] as const satisfies readonly P[];

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];
export const PERMISSION_CODES: readonly PermissionCode[] = PERMISSIONS.map(p => p.code);

const EVERYONE: readonly PermissionCode[] = [
  'sample.view', 'sample.transition', 'sample.notebook.add', 'result.enter',
  'oos.view', 'oos.open', 'oos.edit',
  'spec.view', 'spec.create', 'spec.edit',
  'trace.view', 'trace.dispense', 'record.verify',
  'eln.view', 'eln.create', 'eln.edit', 'eln.sign',
  'instrument.view', 'instrument.register', 'instrument.calibrate',
  'reagent.view', 'reagent.receive', 'reagent.use',
  'env.view', 'env.record', 'env.edit',
  'stability.view', 'stability.create', 'stability.edit',
  'report.view', 'report.generate',
  'training.view', 'ai.use', 'system.info.view',
  'master.view', 'method.view',
  'qms.view', 'qms.create', 'qms.edit',
  'doc.view', 'doc.author', 'doc.print', 'training.acknowledge',
  'custody.view', 'custody.handle', 'label.print',
  'worklist.view',
  'validation.view',
  'spc.view',
];

/** Admin and QA only: approvals, release, audit review. Closing, releasing and certifying were already limited to them. */
const SUPERVISORY: readonly PermissionCode[] = [
  'oos.close', 'spec.approve', 'batch.release', 'training.certify',
  'audit.view', 'audit.verify', 'audit.export', 'security.view', 'security.verify',
  'audit.review', 'audit.review.settings',
  'admin.users.view', 'admin.backup.view', 'admin.jobs.view', 'authz.view', 'authz.role.approve',
  'master.manage', 'master.status', 'method.approve',
  'qms.approve', 'qms.settings',
  'oos.approve', 'oos.settings',
  'env.manage', 'env.correct',
  'result.reintegration.approve',
  'coa.issue',
  'stability.approve',
  'custody.locations', 'custody.approve',
  'reagent.approve',
  'instrument.profile.approve',
  'validation.scope',
  'directory.view', 'directory.approve',
  'spc.manage',
  'periodic.manage', 'periodic.sign', 'archive.manage', 'retention.manage',
];

/** The default matrix: role name to the permission codes it holds. Admin holds every code. */
export const DEFAULT_MATRIX: Record<RoleName, readonly PermissionCode[]> = {
  Admin: PERMISSION_CODES,
  // QA reviews, approves and makes documents effective, manages curricula and signs qualification overrides (r2-docs-training).
  QA: [...EVERYONE, ...SUPERVISORY, 'audit.history.view', 'method.manage', 'doc.review', 'doc.approve', 'training.manage', 'training.override', 'reagent.manage', 'stability.manage', 'instrument.profile.manage', 'worklist.manage', 'periodic.view', 'archive.view'],
  // Reviewer (laboratory supervisor) drafts methods, formulas and test plans; QA approves them (r2-methods-calc). Reviews documents.
  Reviewer: [...EVERYONE, 'audit.history.view', 'method.manage', 'doc.review', 'reagent.manage', 'stability.manage', 'periodic.view', 'archive.view'],
  // Registering samples was Analyst and Admin only: QA and Reviewer do not hold `sample.register`.
  Analyst: [...EVERYONE, 'sample.register', 'worklist.manage'],
};

/**
 * Independence rules (table sod_rules). The person who acts on a record of `entity` must not have taken one of `authorActions`
 * on it; who took them is read from the audit trail. See src/server/authz/sod.ts.
 */
export const SOD_RULES = [
  { code: 'spec.approve', entity: 'Specification', authorActions: ['Create', 'Update'], description: 'The person who approves a specification must not have created or edited it.' },
  { code: 'role.grant', entity: 'UserRole', authorActions: ['RoleChangeRequested'], description: 'The person who approves a role change must be neither the person who requested it nor the person it is for.' },
] as const;
export type SodRuleCode = (typeof SOD_RULES)[number]['code'];

export const isRoleName = (v: unknown): v is RoleName => typeof v === 'string' && (ROLE_NAMES as readonly string[]).includes(v);

/** Client helper: `permissions` is the list GET /api/permissions/me returns. */
export const hasPermission = (granted: readonly string[] | undefined | null, code: PermissionCode): boolean => !!granted && granted.includes(code);

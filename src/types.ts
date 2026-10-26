export type Role = 'Analyst' | 'Reviewer' | 'QA' | 'Admin';

export interface User {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  passwordHash: string; // Stored securely
}

export type SampleState = 'Logged' | 'Testing' | 'Pending Review' | 'Approved' | 'Rejected';

export interface Sample {
  id: string; // e.g. SMP-2026-00001
  material: string;
  batch: string;
  state: SampleState;
  createdBy: string;
  createdAt: string;
  version: number;
  /** The specification revision the sample was registered under (null for samples registered before 0050_results_oos). */
  specId?: string | null;
  specRevision?: number | null;
}

export interface TestResult {
  id: string;
  sampleId: string;
  parameter: string;
  value: string | null;
  specMin: number | null;
  specMax: number | null;
  /** The server's evaluation (results.is_oos). */
  isOos: boolean;
  enteredBy: string | null;
  enteredAt: string | null;
  version: number;
  /** The limit copied from the specification revision at registration; null on rows written before 0050_results_oos. */
  limitKind?: 'RANGE' | 'NMT' | 'NLT' | 'TEXT' | 'PRESENCE' | null;
  lowerText?: string | null;
  upperText?: string | null;
  decimals?: number | null;
  unit?: string | null;
  acceptanceText?: string | null;
}

export interface AuditEntry {
  id: string;
  sequence: number;
  timestamp: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  action: string;
  entity: string;
  entityId: string;
  field: string;
  oldValue: string;
  newValue: string;
  reason: string;
  significant: boolean;
  hash: string;
  prevHash: string;
}

export interface Instrument {
  id: string; // e.g. HPLC-01
  name: string;
  type: string;
  status: 'Active' | 'Out of Service' | 'In Calibration';
  calibrationDueDate: string;
  lastCalibrationDate: string;
}

export interface Reagent {
  id: string;
  name: string;
  lotNumber: string;
  expiryDate: string;
  status: 'Available' | 'Expired' | 'Quarantined';
  quantity: string;
}

export interface EnvRecord {
  id: string;
  location: string;
  grade: 'Grade A' | 'Grade B' | 'Grade C' | 'Grade D' | 'CNC';
  date: string;
  viableCount: number;
  nonViableCount: number;
  status: 'Pass' | 'Alert' | 'Action';
  testedBy: string;
  version: number;
}

/** A specification as GET /specifications returns it (r1-spec); `version` is the concurrency counter, `revisionLabel` the revision. */
export interface Specification {
  id: string;
  material: string;
  revisionLabel: number;
  version: number;
  effectiveDate: string;
  status: 'Active' | 'Obsolete' | 'Draft';
  parameters: import('./lib/validations/specifications').SpecParameter[];
}

export interface Signature {
  id: string;
  sampleId: string;
  signerId: string;
  printedName: string;
  role: string;
  meaning: string;
  reason: string;
  timestamp: string;
  recordVersion: number;
  contentHash: string;
  auditEntryId: string;
}

export interface OOSInvestigation {
  id: string;
  sampleId: string;
  resultId: string;
  parameter: string;
  dateRaised: string;
  /** Open | Closed (v0.1.0 rows may say Approved, read as Closed): src/lib/constants/oos.ts */
  status: string;
  /** Phase I | Phase II | Pending QA while open; null on rows written before 0050_results_oos. */
  phase?: string | null;
  decision?: string | null;
  /** What the screen shows: Closed, or the phase. */
  stage?: string;
  assignedTo: string;
  rootCause: string | null;
  conclusion: string | null;
  version: number;
  signature?: (Signature & { signerRole?: string }) | null;
}

export interface StabilityStudy {
  id: string;
  product: string;
  batch: string;
  condition: string;
  pullPoints: number[];
  startDate: string;
  status: string;
  version: number;
}

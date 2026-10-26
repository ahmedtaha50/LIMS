export type Priority = 'Must' | 'Should' | 'Could';
export type RiskClass = 'High' | 'Medium' | 'Low' | 'Non-GxP';
export type ImplStatus = 'Not started' | 'In progress' | 'Implemented' | 'Blocked' | 'Deferred';
export type VerifStatus = 'Not executed' | 'Passed' | 'Failed' | 'Review pending';
export type VerifMethod = 'T' | 'SA' | 'DR' | 'PV';

export interface Decision {
  id: string;
  description: string;
  owner: string;
  milestone: string;
  linkedRequirements: string[];
  proposedValue?: string;
  status: 'Open' | 'Resolved';
}

export interface Requirement {
  id: string;
  text: string;
  acceptanceCriteria: string;
  priority: Priority;
  riskClass: RiskClass;
  verificationMethod: VerifMethod;
  linkedDecisions?: string[];
  designReference?: string;
  implementingComponents?: string[];
  implementationStatus: ImplStatus;
  verificationStatus: VerifStatus;
  actualEvidence?: string;
  assignedTo?: string;
}


export const decisionRegister: Decision[] = [
  {
    id: 'D-001',
    description: 'Open decision from URS D-001',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-002',
    description: 'Open decision from URS D-002',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-003',
    description: 'Open decision from URS D-003',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-004',
    description: 'Open decision from URS D-004',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-005',
    description: 'Open decision from URS D-005',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-006',
    description: 'Open decision from URS D-006',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-007',
    description: 'Open decision from URS D-007',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-008',
    description: 'Open decision from URS D-008',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-009',
    description: 'Open decision from URS D-009',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-010',
    description: 'Open decision from URS D-010',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-011',
    description: 'Open decision from URS D-011',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-012',
    description: 'Open decision from URS D-012',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-013',
    description: 'Open decision from URS D-013',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-014',
    description: 'Open decision from URS D-014',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-015',
    description: 'Open decision from URS D-015',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-016',
    description: 'Open decision from URS D-016',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-017',
    description: 'Open decision from URS D-017',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-018',
    description: 'Open decision from URS D-018',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-019',
    description: 'Open decision from URS D-019',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-020',
    description: 'Open decision from URS D-020',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  },
  {
    id: 'D-021',
    description: 'Open decision from URS D-021',
    owner: 'System Owner',
    milestone: 'Pre-Deployment',
    linkedRequirements: [],
    proposedValue: 'UNAPPROVED DEVELOPMENT ASSUMPTION: To be configured',
    status: 'Open'
  }
];

export const requirementsRegister: Requirement[] = [
  {
    id: 'AT-001',
    text: 'The system must maintain a secure, computer-generated, time-stamped audit trail for all creations, modifications, and deletions of GxP records.',
    acceptanceCriteria: 'Audit trail entries include old/new values, user ID, timestamp, and action. Entries cannot be modified or deleted.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'T',
    designReference: 'src/db/schema.ts (auditTrail table)',
    implementingComponents: ['writeAudit', 'apiRouter'],
    implementationStatus: 'Implemented',
    verificationStatus: 'Review pending',
    actualEvidence: 'Audit records successfully written during sample creation, OOS updates, and signature events.'
  },
  {
    id: 'ES-001',
    text: 'Electronic signatures must require at least two distinct identification components (e.g., ID and password) for a single continuous session.',
    acceptanceCriteria: 'User must enter password to sign. Meaning of signature is captured.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'T',
    designReference: 'src/components/ElectronicSignatureModal.tsx',
    implementingComponents: ['SignatureModal', '/api/sign'],
    implementationStatus: 'Implemented',
    verificationStatus: 'Review pending',
    actualEvidence: 'Password verified using bcrypt in /api/sign before appending signature record.'
  },
  {
    id: 'CI-001',
    text: 'The system must implement Optimistic Concurrency Control to prevent lost updates.',
    acceptanceCriteria: 'Updates verify the record version. Conflicting updates are rejected with a specific error.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'T',
    designReference: 'version field in schema.ts',
    implementingComponents: ['PUT endpoints in api.ts'],
    implementationStatus: 'Implemented',
    verificationStatus: 'Review pending',
    actualEvidence: 'Tested on OOS, Stability, and Env endpoints. 409 Conflict returned on version mismatch.'
  },
  {
    id: 'QE-001',
    text: 'The system must allow QA to initiate and track Out of Specification (OOS) investigations linked to specific test results.',
    acceptanceCriteria: 'OOS record includes Sample ID, Result ID, Parameter, Date, Status, Root Cause, Conclusion.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'T',
    designReference: 'oosInvestigations table',
    implementingComponents: ['OOSInvestigations.tsx', 'api.ts'],
    implementationStatus: 'Implemented',
    verificationStatus: 'Review pending',
    actualEvidence: 'CRUD operations functioning with OCC and Audit Trail.'
  },
  {
    id: 'ST-001',
    text: 'The system must manage stability studies, tracking protocols, pull points, and conditions.',
    acceptanceCriteria: 'Stability protocol records product, batch, condition, and status securely.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'T',
    designReference: 'stabilityStudies table',
    implementingComponents: ['StabilityStudies.tsx', 'api.ts'],
    implementationStatus: 'Implemented',
    verificationStatus: 'Review pending',
    actualEvidence: 'Stability creation and updates working with optimistic concurrency.'
  },
  {
    id: 'MB-001',
    text: 'The system must log environmental monitoring records for viable and non-viable counts.',
    acceptanceCriteria: 'Env records capture grade, location, date, and counts with status derivation.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'T',
    designReference: 'envRecords table',
    implementingComponents: ['Environmental.tsx', 'api.ts'],
    implementationStatus: 'Implemented',
    verificationStatus: 'Review pending',
    actualEvidence: 'Environmental records fully integrated with version control and audit.'
  },
  {
    id: 'SM-001',
    text: 'The system must track sample lifecycle from registration through disposition.',
    acceptanceCriteria: 'Sample ID, material, batch, and state are tracked and versioned.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'T',
    designReference: 'samples table',
    implementingComponents: ['Sample Dashboard', 'api.ts'],
    implementationStatus: 'Implemented',
    verificationStatus: 'Review pending',
    actualEvidence: 'Samples registered with standard URS schema requirements.'
  },
  {
    id: 'SM-002',
    text: 'Pending requirement extraction from URS for SM-002.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Could',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-003',
    text: 'Pending requirement extraction from URS for MD-003.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-004',
    text: 'Pending requirement extraction from URS for CH-004.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-005',
    text: 'Pending requirement extraction from URS for MB-005.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-006',
    text: 'Pending requirement extraction from URS for ST-006.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-007',
    text: 'Pending requirement extraction from URS for RM-007.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-008',
    text: 'Pending requirement extraction from URS for IN-008.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-009',
    text: 'Pending requirement extraction from URS for QE-009.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-010',
    text: 'Pending requirement extraction from URS for RV-010.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-011',
    text: 'Pending requirement extraction from URS for AN-011.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-012',
    text: 'Pending requirement extraction from URS for DI-012.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-013',
    text: 'Pending requirement extraction from URS for AT-013.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-014',
    text: 'Pending requirement extraction from URS for ES-014.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-015',
    text: 'Pending requirement extraction from URS for CI-015.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-016',
    text: 'Pending requirement extraction from URS for SC-016.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-017',
    text: 'Pending requirement extraction from URS for IF-017.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-018',
    text: 'Pending requirement extraction from URS for MG-018.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-019',
    text: 'Pending requirement extraction from URS for NF-019.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-020',
    text: 'Pending requirement extraction from URS for BC-020.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-021',
    text: 'Pending requirement extraction from URS for VL-021.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-022',
    text: 'Pending requirement extraction from URS for TR-022.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-023',
    text: 'Pending requirement extraction from URS for SM-023.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-024',
    text: 'Pending requirement extraction from URS for MD-024.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-025',
    text: 'Pending requirement extraction from URS for CH-025.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-026',
    text: 'Pending requirement extraction from URS for MB-026.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-027',
    text: 'Pending requirement extraction from URS for ST-027.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-028',
    text: 'Pending requirement extraction from URS for RM-028.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-029',
    text: 'Pending requirement extraction from URS for IN-029.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-030',
    text: 'Pending requirement extraction from URS for QE-030.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-031',
    text: 'Pending requirement extraction from URS for RV-031.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-032',
    text: 'Pending requirement extraction from URS for AN-032.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-033',
    text: 'Pending requirement extraction from URS for DI-033.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-034',
    text: 'Pending requirement extraction from URS for AT-034.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Should',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-035',
    text: 'Pending requirement extraction from URS for ES-035.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-036',
    text: 'Pending requirement extraction from URS for CI-036.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-037',
    text: 'Pending requirement extraction from URS for SC-037.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-038',
    text: 'Pending requirement extraction from URS for IF-038.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-039',
    text: 'Pending requirement extraction from URS for MG-039.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-040',
    text: 'Pending requirement extraction from URS for NF-040.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-041',
    text: 'Pending requirement extraction from URS for BC-041.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-042',
    text: 'Pending requirement extraction from URS for VL-042.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-043',
    text: 'Pending requirement extraction from URS for TR-043.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-044',
    text: 'Pending requirement extraction from URS for SM-044.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-045',
    text: 'Pending requirement extraction from URS for MD-045.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-046',
    text: 'Pending requirement extraction from URS for CH-046.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-047',
    text: 'Pending requirement extraction from URS for MB-047.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-048',
    text: 'Pending requirement extraction from URS for ST-048.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-049',
    text: 'Pending requirement extraction from URS for RM-049.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-050',
    text: 'Pending requirement extraction from URS for IN-050.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-051',
    text: 'Pending requirement extraction from URS for QE-051.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-052',
    text: 'Pending requirement extraction from URS for RV-052.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-053',
    text: 'Pending requirement extraction from URS for AN-053.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-054',
    text: 'Pending requirement extraction from URS for DI-054.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-055',
    text: 'Pending requirement extraction from URS for AT-055.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-056',
    text: 'Pending requirement extraction from URS for ES-056.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-057',
    text: 'Pending requirement extraction from URS for CI-057.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-058',
    text: 'Pending requirement extraction from URS for SC-058.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-059',
    text: 'Pending requirement extraction from URS for IF-059.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-060',
    text: 'Pending requirement extraction from URS for MG-060.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-061',
    text: 'Pending requirement extraction from URS for NF-061.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-062',
    text: 'Pending requirement extraction from URS for BC-062.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-063',
    text: 'Pending requirement extraction from URS for VL-063.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-064',
    text: 'Pending requirement extraction from URS for TR-064.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-065',
    text: 'Pending requirement extraction from URS for SM-065.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-066',
    text: 'Pending requirement extraction from URS for MD-066.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-067',
    text: 'Pending requirement extraction from URS for CH-067.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-068',
    text: 'Pending requirement extraction from URS for MB-068.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-069',
    text: 'Pending requirement extraction from URS for ST-069.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-070',
    text: 'Pending requirement extraction from URS for RM-070.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-071',
    text: 'Pending requirement extraction from URS for IN-071.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-072',
    text: 'Pending requirement extraction from URS for QE-072.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-073',
    text: 'Pending requirement extraction from URS for RV-073.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-074',
    text: 'Pending requirement extraction from URS for AN-074.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-075',
    text: 'Pending requirement extraction from URS for DI-075.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-076',
    text: 'Pending requirement extraction from URS for AT-076.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-077',
    text: 'Pending requirement extraction from URS for ES-077.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-078',
    text: 'Pending requirement extraction from URS for CI-078.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-079',
    text: 'Pending requirement extraction from URS for SC-079.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-080',
    text: 'Pending requirement extraction from URS for IF-080.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-081',
    text: 'Pending requirement extraction from URS for MG-081.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-082',
    text: 'Pending requirement extraction from URS for NF-082.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-083',
    text: 'Pending requirement extraction from URS for BC-083.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-084',
    text: 'Pending requirement extraction from URS for VL-084.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-085',
    text: 'Pending requirement extraction from URS for TR-085.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-086',
    text: 'Pending requirement extraction from URS for SM-086.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-087',
    text: 'Pending requirement extraction from URS for MD-087.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-088',
    text: 'Pending requirement extraction from URS for CH-088.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-089',
    text: 'Pending requirement extraction from URS for MB-089.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-090',
    text: 'Pending requirement extraction from URS for ST-090.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-091',
    text: 'Pending requirement extraction from URS for RM-091.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'High',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-092',
    text: 'Pending requirement extraction from URS for IN-092.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-093',
    text: 'Pending requirement extraction from URS for QE-093.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-094',
    text: 'Pending requirement extraction from URS for RV-094.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-095',
    text: 'Pending requirement extraction from URS for AN-095.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-096',
    text: 'Pending requirement extraction from URS for DI-096.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-097',
    text: 'Pending requirement extraction from URS for AT-097.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-098',
    text: 'Pending requirement extraction from URS for ES-098.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-099',
    text: 'Pending requirement extraction from URS for CI-099.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-100',
    text: 'Pending requirement extraction from URS for SC-100.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-101',
    text: 'Pending requirement extraction from URS for IF-101.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-102',
    text: 'Pending requirement extraction from URS for MG-102.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-103',
    text: 'Pending requirement extraction from URS for NF-103.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-104',
    text: 'Pending requirement extraction from URS for BC-104.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-105',
    text: 'Pending requirement extraction from URS for VL-105.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-106',
    text: 'Pending requirement extraction from URS for TR-106.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-107',
    text: 'Pending requirement extraction from URS for SM-107.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-108',
    text: 'Pending requirement extraction from URS for MD-108.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-109',
    text: 'Pending requirement extraction from URS for CH-109.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-110',
    text: 'Pending requirement extraction from URS for MB-110.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-111',
    text: 'Pending requirement extraction from URS for ST-111.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-112',
    text: 'Pending requirement extraction from URS for RM-112.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-113',
    text: 'Pending requirement extraction from URS for IN-113.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-114',
    text: 'Pending requirement extraction from URS for QE-114.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Low',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-115',
    text: 'Pending requirement extraction from URS for RV-115.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Non-GxP',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-116',
    text: 'Pending requirement extraction from URS for AN-116.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Non-GxP',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-117',
    text: 'Pending requirement extraction from URS for DI-117.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Non-GxP',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-118',
    text: 'Pending requirement extraction from URS for AT-118.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Non-GxP',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-119',
    text: 'Pending requirement extraction from URS for ES-119.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Non-GxP',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-120',
    text: 'Pending requirement extraction from URS for CI-120.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Non-GxP',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-121',
    text: 'Pending requirement extraction from URS for SC-121.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Non-GxP',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-122',
    text: 'Pending requirement extraction from URS for IF-122.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Non-GxP',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-123',
    text: 'Pending requirement extraction from URS for MG-123.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-124',
    text: 'Pending requirement extraction from URS for NF-124.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-125',
    text: 'Pending requirement extraction from URS for BC-125.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-126',
    text: 'Pending requirement extraction from URS for VL-126.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-127',
    text: 'Pending requirement extraction from URS for TR-127.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-128',
    text: 'Pending requirement extraction from URS for SM-128.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-129',
    text: 'Pending requirement extraction from URS for MD-129.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-130',
    text: 'Pending requirement extraction from URS for CH-130.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-131',
    text: 'Pending requirement extraction from URS for MB-131.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-132',
    text: 'Pending requirement extraction from URS for ST-132.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-133',
    text: 'Pending requirement extraction from URS for RM-133.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-134',
    text: 'Pending requirement extraction from URS for IN-134.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-135',
    text: 'Pending requirement extraction from URS for QE-135.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-136',
    text: 'Pending requirement extraction from URS for RV-136.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-137',
    text: 'Pending requirement extraction from URS for AN-137.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-138',
    text: 'Pending requirement extraction from URS for DI-138.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-139',
    text: 'Pending requirement extraction from URS for AT-139.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-140',
    text: 'Pending requirement extraction from URS for ES-140.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-141',
    text: 'Pending requirement extraction from URS for CI-141.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-142',
    text: 'Pending requirement extraction from URS for SC-142.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-143',
    text: 'Pending requirement extraction from URS for IF-143.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-144',
    text: 'Pending requirement extraction from URS for MG-144.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-145',
    text: 'Pending requirement extraction from URS for NF-145.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-146',
    text: 'Pending requirement extraction from URS for BC-146.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-147',
    text: 'Pending requirement extraction from URS for VL-147.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-148',
    text: 'Pending requirement extraction from URS for TR-148.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-149',
    text: 'Pending requirement extraction from URS for SM-149.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-150',
    text: 'Pending requirement extraction from URS for MD-150.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-151',
    text: 'Pending requirement extraction from URS for CH-151.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-152',
    text: 'Pending requirement extraction from URS for MB-152.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-153',
    text: 'Pending requirement extraction from URS for ST-153.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-154',
    text: 'Pending requirement extraction from URS for RM-154.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-155',
    text: 'Pending requirement extraction from URS for IN-155.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-156',
    text: 'Pending requirement extraction from URS for QE-156.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-157',
    text: 'Pending requirement extraction from URS for RV-157.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-158',
    text: 'Pending requirement extraction from URS for AN-158.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-159',
    text: 'Pending requirement extraction from URS for DI-159.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-160',
    text: 'Pending requirement extraction from URS for AT-160.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-161',
    text: 'Pending requirement extraction from URS for ES-161.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-162',
    text: 'Pending requirement extraction from URS for CI-162.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-163',
    text: 'Pending requirement extraction from URS for SC-163.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-164',
    text: 'Pending requirement extraction from URS for IF-164.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-165',
    text: 'Pending requirement extraction from URS for MG-165.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-166',
    text: 'Pending requirement extraction from URS for NF-166.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-167',
    text: 'Pending requirement extraction from URS for BC-167.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-168',
    text: 'Pending requirement extraction from URS for VL-168.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-169',
    text: 'Pending requirement extraction from URS for TR-169.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-170',
    text: 'Pending requirement extraction from URS for SM-170.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-171',
    text: 'Pending requirement extraction from URS for MD-171.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-172',
    text: 'Pending requirement extraction from URS for CH-172.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-173',
    text: 'Pending requirement extraction from URS for MB-173.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-174',
    text: 'Pending requirement extraction from URS for ST-174.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-175',
    text: 'Pending requirement extraction from URS for RM-175.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-176',
    text: 'Pending requirement extraction from URS for IN-176.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-177',
    text: 'Pending requirement extraction from URS for QE-177.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-178',
    text: 'Pending requirement extraction from URS for RV-178.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-179',
    text: 'Pending requirement extraction from URS for AN-179.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-180',
    text: 'Pending requirement extraction from URS for DI-180.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-181',
    text: 'Pending requirement extraction from URS for AT-181.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-182',
    text: 'Pending requirement extraction from URS for ES-182.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-183',
    text: 'Pending requirement extraction from URS for CI-183.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-184',
    text: 'Pending requirement extraction from URS for SC-184.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-185',
    text: 'Pending requirement extraction from URS for IF-185.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-186',
    text: 'Pending requirement extraction from URS for MG-186.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-187',
    text: 'Pending requirement extraction from URS for NF-187.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-188',
    text: 'Pending requirement extraction from URS for BC-188.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-189',
    text: 'Pending requirement extraction from URS for VL-189.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-190',
    text: 'Pending requirement extraction from URS for TR-190.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-191',
    text: 'Pending requirement extraction from URS for SM-191.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-192',
    text: 'Pending requirement extraction from URS for MD-192.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-193',
    text: 'Pending requirement extraction from URS for CH-193.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-194',
    text: 'Pending requirement extraction from URS for MB-194.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-195',
    text: 'Pending requirement extraction from URS for ST-195.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-196',
    text: 'Pending requirement extraction from URS for RM-196.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-197',
    text: 'Pending requirement extraction from URS for IN-197.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-198',
    text: 'Pending requirement extraction from URS for QE-198.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-199',
    text: 'Pending requirement extraction from URS for RV-199.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-200',
    text: 'Pending requirement extraction from URS for AN-200.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-201',
    text: 'Pending requirement extraction from URS for DI-201.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-202',
    text: 'Pending requirement extraction from URS for AT-202.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-203',
    text: 'Pending requirement extraction from URS for ES-203.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-204',
    text: 'Pending requirement extraction from URS for CI-204.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-205',
    text: 'Pending requirement extraction from URS for SC-205.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-206',
    text: 'Pending requirement extraction from URS for IF-206.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-207',
    text: 'Pending requirement extraction from URS for MG-207.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-208',
    text: 'Pending requirement extraction from URS for NF-208.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-209',
    text: 'Pending requirement extraction from URS for BC-209.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-210',
    text: 'Pending requirement extraction from URS for VL-210.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-211',
    text: 'Pending requirement extraction from URS for TR-211.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-212',
    text: 'Pending requirement extraction from URS for SM-212.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-213',
    text: 'Pending requirement extraction from URS for MD-213.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-214',
    text: 'Pending requirement extraction from URS for CH-214.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-215',
    text: 'Pending requirement extraction from URS for MB-215.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-216',
    text: 'Pending requirement extraction from URS for ST-216.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-217',
    text: 'Pending requirement extraction from URS for RM-217.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-218',
    text: 'Pending requirement extraction from URS for IN-218.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-219',
    text: 'Pending requirement extraction from URS for QE-219.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-220',
    text: 'Pending requirement extraction from URS for RV-220.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-221',
    text: 'Pending requirement extraction from URS for AN-221.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-222',
    text: 'Pending requirement extraction from URS for DI-222.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-223',
    text: 'Pending requirement extraction from URS for AT-223.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ES-224',
    text: 'Pending requirement extraction from URS for ES-224.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CI-225',
    text: 'Pending requirement extraction from URS for CI-225.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SC-226',
    text: 'Pending requirement extraction from URS for SC-226.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IF-227',
    text: 'Pending requirement extraction from URS for IF-227.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MG-228',
    text: 'Pending requirement extraction from URS for MG-228.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'NF-229',
    text: 'Pending requirement extraction from URS for NF-229.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'BC-230',
    text: 'Pending requirement extraction from URS for BC-230.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'VL-231',
    text: 'Pending requirement extraction from URS for VL-231.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'TR-232',
    text: 'Pending requirement extraction from URS for TR-232.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'SM-233',
    text: 'Pending requirement extraction from URS for SM-233.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MD-234',
    text: 'Pending requirement extraction from URS for MD-234.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'CH-235',
    text: 'Pending requirement extraction from URS for CH-235.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'MB-236',
    text: 'Pending requirement extraction from URS for MB-236.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'ST-237',
    text: 'Pending requirement extraction from URS for ST-237.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RM-238',
    text: 'Pending requirement extraction from URS for RM-238.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'IN-239',
    text: 'Pending requirement extraction from URS for IN-239.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'QE-240',
    text: 'Pending requirement extraction from URS for QE-240.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'RV-241',
    text: 'Pending requirement extraction from URS for RV-241.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AN-242',
    text: 'Pending requirement extraction from URS for AN-242.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'DI-243',
    text: 'Pending requirement extraction from URS for DI-243.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  },
  {
    id: 'AT-244',
    text: 'Pending requirement extraction from URS for AT-244.',
    acceptanceCriteria: 'Pending criteria extraction.',
    priority: 'Must',
    riskClass: 'Medium',
    verificationMethod: 'SA',
    implementationStatus: 'Not started',
    verificationStatus: 'Not executed'
  }
];

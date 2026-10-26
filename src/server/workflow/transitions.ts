import { Sample, User, SampleState, Role } from '../../types';

export interface TransitionRule {
  from: SampleState | '*';
  to: SampleState;
  allowedRoles: Role[];
  requiresSignature: boolean;
  signatureMeaning?: string;
  validateSoD?: (sample: Sample, currentUser: User) => boolean;
}

/**
 * Defines the state machine and GxP transition rules for a Sample lifecycle.
 */
export const SampleWorkflow: TransitionRule[] = [
  {
    from: 'Logged',
    to: 'Testing',
    allowedRoles: ['Analyst', 'Admin'],
    requiresSignature: false, // Simply starting the test, no formal signature usually required
  },
  {
    from: 'Testing',
    to: 'Pending Review',
    allowedRoles: ['Analyst', 'Admin'],
    requiresSignature: true,
    signatureMeaning: 'Submit for Review - I confirm results are accurate and complete',
  },
  {
    from: 'Pending Review',
    to: 'Approved',
    allowedRoles: ['Reviewer', 'QA', 'Admin'],
    requiresSignature: true,
    signatureMeaning: 'Approval of Results - Batch Release',
    validateSoD: (sample: Sample, currentUser: User) => {
      // Segregation of Duties: The person approving cannot be the person who logged/tested it
      return sample.createdBy !== currentUser.id;
    }
  },
  {
    from: 'Pending Review',
    to: 'Rejected',
    allowedRoles: ['Reviewer', 'QA', 'Admin'],
    requiresSignature: true,
    signatureMeaning: 'Rejection of Results',
    validateSoD: (sample: Sample, currentUser: User) => {
      // Segregation of Duties: The person rejecting cannot be the person who logged/tested it
      return sample.createdBy !== currentUser.id;
    }
  },
  {
    from: 'Testing',
    to: 'Rejected', // Edge case: QC/QA rejects immediately due to critical failure
    allowedRoles: ['QA', 'Admin'],
    requiresSignature: true,
    signatureMeaning: 'Immediate Rejection (Quality Failure)',
  },
  {
    from: 'Approved',
    to: 'Rejected', // Edge case: Post-approval revocation (OOS discovered later)
    allowedRoles: ['QA', 'Admin'],
    requiresSignature: true,
    signatureMeaning: 'Revocation of Approval',
  }
];

export interface TransitionResult {
  allowed: boolean;
  reason?: string;
  requiresSignature?: boolean;
  signatureMeaning?: string;
}

/**
 * Validates if a user can transition a sample to a new state based on GxP rules.
 */
export function validateTransition(sample: Sample, newState: SampleState, user: User): TransitionResult {
  if (sample.state === newState) {
    return { allowed: false, reason: 'Sample is already in this state.' };
  }

  const rule = SampleWorkflow.find(r => (r.from === sample.state || r.from === '*') && r.to === newState);
  
  if (!rule) {
    return { allowed: false, reason: `Invalid workflow transition from '${sample.state}' to '${newState}'.` };
  }

  if (!rule.allowedRoles.includes(user.role)) {
    return { 
      allowed: false, 
      reason: `Unauthorized: Role '${user.role}' is not permitted to transition sample to '${newState}'. Allowed roles: ${rule.allowedRoles.join(', ')}.` 
    };
  }

  if (rule.validateSoD && !rule.validateSoD(sample, user)) {
    return { 
      allowed: false, 
      reason: 'Segregation of Duties Violation: You cannot review, approve, or reject a sample you created or tested.' 
    };
  }

  return { 
    allowed: true, 
    requiresSignature: rule.requiresSignature,
    signatureMeaning: rule.signatureMeaning 
  };
}

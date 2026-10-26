/**
 * Roadmap M07 (r1-esign), the screens: what the signature dialog requires before the user types anything, and how a verification
 * verdict is shown. Rendered on the server with react-dom (no browser); the data-loading effects are covered by the API tests.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ElectronicSignatureModal, signingGate, type CatalogMeaning } from '../../src/components/ElectronicSignatureModal';
import { SignatureVerdict } from '../../src/components/SignatureBlock';

const meaning = (over: Partial<CatalogMeaning> = {}): CatalogMeaning => ({ code: 'APPROVAL', text: 'Approval: I approve.', requiresReason: false, trainingExempt: false, allowedForYou: true, ...over });
const untrained = { hasCompletedSoftwareTraining: false };

describe('signingGate: the rules come from the meaning', () => {
  it('blocks an untrained user for an ordinary meaning', () => {
    expect(signingGate({ catalog: meaning(), user: untrained }).trainingBlocked).toBe(true);
  });

  it('does not block an untrained user for a meaning flagged training-exempt, whatever the action is called', () => {
    expect(signingGate({ catalog: meaning({ code: 'TRAINING_ACKNOWLEDGEMENT', trainingExempt: true }), user: untrained, action: 'approve' }).trainingBlocked).toBe(false);
  });

  it('no longer lets the name of the action or a flag from the caller exempt a meaning that is not exempt', () => {
    const gate = signingGate({ catalog: meaning(), user: untrained, action: 'training_certify', isTrainingBypass: true });
    expect(gate.trainingBlocked).toBe(true);
  });

  it('keeps the old heuristics for a caller that names no meaning code', () => {
    expect(signingGate({ catalog: null, user: untrained, action: 'training_certify' }).trainingBlocked).toBe(false);
    expect(signingGate({ catalog: null, user: untrained, isTrainingBypass: true }).trainingBlocked).toBe(false);
    expect(signingGate({ catalog: null, user: untrained, action: 'approve' }).trainingBlocked).toBe(true);
  });

  it('blocks a role the meaning is not for, asks for a code only from a user with an authenticator, and takes the reason rule from the meaning', () => {
    expect(signingGate({ catalog: meaning({ allowedForYou: false }) }).roleBlocked).toBe(true);
    expect(signingGate({ catalog: meaning(), user: { mfaEnabled: true } }).mfaRequired).toBe(true);
    expect(signingGate({ catalog: meaning(), user: { mfaEnabled: false } }).mfaRequired).toBe(false);
    expect(signingGate({ catalog: meaning({ requiresReason: true }), action: 'sign' }).reasonMandatory).toBe(true);
    expect(signingGate({ catalog: meaning({ requiresReason: false }), action: 'reject' }).reasonMandatory).toBe(false);
  });
});

describe('ElectronicSignatureModal', () => {
  const render = (user: Record<string, unknown>) => renderToStaticMarkup(React.createElement(ElectronicSignatureModal, { user, meaningCode: 'APPROVAL', action: 'approve', onClose: () => {}, onSign: () => {} }));

  it('asks for the authenticator code when the signer has one, and not otherwise', () => {
    expect(render({ name: 'A', role: 'QA', hasCompletedSoftwareTraining: true, mfaEnabled: true })).toContain('Authenticator Code');
    expect(render({ name: 'A', role: 'QA', hasCompletedSoftwareTraining: true, mfaEnabled: false })).not.toContain('Authenticator Code');
  });

  it('shows the training guardrail to an untrained user', () => {
    expect(render({ name: 'A', role: 'QA', hasCompletedSoftwareTraining: false })).toContain('GxP Compliance Guardrail Active');
  });
});

describe('SignatureVerdict', () => {
  const show = (status: string, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(React.createElement(SignatureVerdict, { result: { valid: status === 'valid', status, contentHashMatches: status === 'valid' ? true : null, chainIntact: true, ...over } }));

  it('is green and says verified only for status valid', () => {
    const html = show('valid');
    expect(html).toContain('Verified');
    expect(html).toContain('emerald');
  });

  it('is red for a record changed after signing, a missing record and a broken audit chain', () => {
    for (const status of ['record-modified', 'record-missing', 'chain-broken', 'audit-missing']) {
      const html = show(status, { contentHashMatches: false });
      expect(html, status).toContain('FAILED');
      expect(html, status).toContain('red');
      expect(html, status).not.toContain('emerald');
    }
  });

  it('is amber, and not green, for a legacy signature that cannot be recomputed', () => {
    const html = show('legacy-unverifiable');
    expect(html).toContain('Cannot be verified');
    expect(html).toContain('amber');
    expect(html).not.toContain('emerald');
    expect(html).toContain('hash not recomputable');
  });

  it('does not show a status it does not know as verified', () => {
    const html = show('something-new');
    expect(html).toContain('Unrecognised verification status');
    expect(html).not.toContain('emerald');
  });
});

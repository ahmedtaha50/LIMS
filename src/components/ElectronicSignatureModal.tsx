import { formatDate, formatTime } from '../lib/format';
import React, { useState, useEffect, useId } from 'react';
import { 
  ShieldCheck, 
  KeyRound, 
  Clock, 
  UserCheck, 
  AlertTriangle, 
  Eye, 
  EyeOff, 
  Fingerprint, 
  Lock, 
  CheckCircle2, 
  GraduationCap, 
  ExternalLink,
  X
} from 'lucide-react';

export interface ElectronicSignatureModalProps {
  user?: {
    id?: string;
    name?: string;
    email?: string;
    role?: string;
    hasCompletedSoftwareTraining?: boolean;
    failedAttempts?: number;
    /** From GET /auth/me: the signer has an authenticator and must enter a current code to sign. */
    mfaEnabled?: boolean;
  };
  /**
   * The catalog code of the meaning (GET /api/signatures/meanings). With it, the text, the reason rule and the training exemption
   * shown here are the server's, and onSign passes the code back: the client names a meaning, the server decides what it says.
   */
  meaningCode?: string;
  /** Bearer token, needed only to read the catalog for `meaningCode`. */
  token?: string;
  /** Display text for callers that have not moved to `meaningCode`; the server stores its own text, not this one. */
  meaning?: string;
  action?: string;
  actionName?: string;
  entityName?: string;
  recordVersion?: number | string;
  requiresReason?: boolean;
  defaultReason?: string;
  isOpen?: boolean;
  /** Only for callers without `meaningCode`. With a code, the exemption is the catalog's training_exempt flag. */
  isTrainingBypass?: boolean; // Context-aware bypass for the Training module itself (RULE[AGENTS_md])
  children?: React.ReactNode;
  onClose: () => void;
  onSign: (password: string, reason?: string, totpCode?: string, meaningCode?: string) => Promise<void> | void;
}

export interface CatalogMeaning { code: string; text: string; requiresReason: boolean; trainingExempt: boolean; allowedForYou: boolean }

/**
 * What stops or shapes a signature before the user types anything. With a catalog meaning the rules are the server's own (the
 * server applies the same ones when the signature arrives); without one, the caller's hints and the action name decide, as before.
 */
export function signingGate(input: {
  catalog: CatalogMeaning | null;
  user?: { hasCompletedSoftwareTraining?: boolean; mfaEnabled?: boolean };
  action?: string;
  isTrainingBypass?: boolean;
  explicitRequiresReason?: boolean;
}) {
  const action = (input.action || 'sign').toLowerCase();
  const { catalog, user } = input;
  const trainingExempt = catalog ? catalog.trainingExempt : (input.isTrainingBypass === true || action.includes('training'));
  return {
    trainingBlocked: user?.hasCompletedSoftwareTraining === false && !trainingExempt,
    roleBlocked: catalog ? !catalog.allowedForYou : false,
    mfaRequired: user?.mfaEnabled === true,
    reasonMandatory: catalog
      ? catalog.requiresReason
      : input.explicitRequiresReason !== undefined
        ? input.explicitRequiresReason
        : (action.includes('reject') || action.includes('oos') || action.includes('close')),
  };
}

export function ElectronicSignatureModal({
  user = { name: 'Authorized Signer', role: 'Analyst', hasCompletedSoftwareTraining: true },
  meaningCode,
  token,
  meaning,
  action,
  actionName,
  entityName,
  recordVersion,
  requiresReason: explicitRequiresReason,
  defaultReason = '',
  isOpen = true,
  isTrainingBypass = false,
  children,
  onClose,
  onSign
}: ElectronicSignatureModalProps) {
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [catalog, setCatalog] = useState<CatalogMeaning | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [reason, setReason] = useState(defaultReason);
  const [affirmed, setAffirmed] = useState(false);
  const [timestamp, setTimestamp] = useState(new Date());
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [capsLockActive, setCapsLockActive] = useState(false);
  const [cryptoFingerprint, setCryptoFingerprint] = useState('');

  const affirmationId = useId();
  const totpId = useId();

  // Contemporary Real-Time Clock
  useEffect(() => {
    const timer = setInterval(() => setTimestamp(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // The meaning, the reason rule and the training exemption come from the server's catalog when the caller names a code.
  useEffect(() => {
    if (!meaningCode || !token) return;
    let cancelled = false;
    setCatalogError(null);
    (async () => {
      try {
        const res = await fetch('/api/signatures/meanings', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The signature meanings could not be loaded (HTTP ${res.status}).`);
        const list: CatalogMeaning[] = await res.json();
        const found = list.find(m => m.code === meaningCode);
        if (!found) throw new Error(`The signature meaning ${meaningCode} is not in the catalog.`);
        if (!cancelled) setCatalog(found);
      } catch (e: any) {
        if (!cancelled) setCatalogError(e.message || 'The signature meanings could not be loaded.');
      }
    })();
    return () => { cancelled = true; };
  }, [meaningCode, token]);

  // Update default reason if prop changes
  useEffect(() => {
    if (defaultReason && !reason) {
      setReason(defaultReason);
    }
  }, [defaultReason]);

  const effectiveAction = (action || actionName || 'sign').toLowerCase();
  
  const gate = signingGate({ catalog, user, action: effectiveAction, isTrainingBypass, explicitRequiresReason });
  const isReasonMandatory = gate.reasonMandatory;

  const effectiveMeaning = catalog?.text || meaning || (
    effectiveAction.includes('approve') ? 'Approval (Release Disposition)' :
    effectiveAction.includes('reject') ? 'Rejection (Quarantine / Returned)' :
    effectiveAction.includes('review') ? 'Review & Verification of Analytical Results' :
    effectiveAction.includes('oos') ? 'OOS Investigation Closure & Disposition Approval' :
    'Authorship & Verification of Laboratory Records'
  );

  // Check Software Training Guardrail (RULE[AGENTS_md])
  const isTrainingBlocked = gate.trainingBlocked;
  const mfaRequired = gate.mfaRequired;
  const isRoleBlocked = gate.roleBlocked;
  const totpComplete = !mfaRequired || /^\d{6}$/.test(totpCode);

  // Compute live cryptographic fingerprint preview using Web Crypto API
  useEffect(() => {
    const computePreview = async () => {
      try {
        const payload = `${user?.id || 'usr'}:${entityName || 'record'}:${recordVersion || 1}:${effectiveMeaning}:${reason}:${timestamp.toISOString()}`;
        const encoder = new TextEncoder();
        const data = encoder.encode(payload);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        setCryptoFingerprint(hashHex);
      } catch {
        setCryptoFingerprint('sha256-cryptographic-hash-active');
      }
    };
    computePreview();
  }, [user?.id, entityName, recordVersion, effectiveMeaning, reason, timestamp]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isTrainingBlocked || isRoleBlocked) return;
    if (isReasonMandatory && reason.trim().length < 5) {
      setErrorMessage('A detailed reason (minimum 5 characters) is required for compliance.');
      return;
    }
    if (!affirmed) {
      setErrorMessage('You must acknowledge the 21 CFR Part 11 legal declaration before signing.');
      return;
    }
    if (!password) {
      setErrorMessage('Password is required for electronic signature authentication.');
      return;
    }

    if (!totpComplete) {
      setErrorMessage('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      await onSign(password, reason, mfaRequired ? totpCode : undefined, meaningCode);
    } catch (err: any) {
      setErrorMessage(err.message || 'Electronic signature authentication failed.');
      setPassword(''); // clear password for security
      setTotpCode(''); // a code is good for one signature
      setSubmitting(false);
    }
  };

  // Gregorian, Latin digits, month as a word, time zone offset shown: the same text in English and Arabic (src/lib/format.ts).
  const timeLocalStr = formatTime(timestamp, { digits: 'latin' });
  const dateLocalStr = formatDate(timestamp, { digits: 'latin' });
  const timeUtcStr = timestamp.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

  return (
    <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div 
        role="dialog"
        aria-modal="true"
        aria-labelledby="esign-title"
        className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-200 my-8"
      >
        {/* Header: GxP 21 CFR Part 11 */}
        <div className="px-6 py-4.5 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/20 text-blue-400 rounded-lg border border-blue-400/30">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 id="esign-title" className="font-semibold text-base tracking-tight text-white flex items-center gap-2">
                Electronic Signature Manifestation
              </h3>
              <p className="text-xs text-slate-400 font-mono">
                FDA 21 CFR Part 11 & EU GMP Annex 11
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
            title="Cancel signature"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Training Guardrail Alert (RULE[AGENTS_md]) */}
        {isTrainingBlocked && (
          <div className="p-5 bg-amber-50 border-b border-amber-200 flex items-start gap-3.5">
            <GraduationCap className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1.5 text-xs text-amber-900">
              <h4 className="font-bold text-amber-950 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                GxP Compliance Guardrail Active
              </h4>
              <p className="leading-relaxed">
                Electronic signatures across all production modules are <strong>disabled</strong> for your account because you have not completed the required <strong>21 CFR Part 11 Software Training</strong>.
              </p>
              <div className="pt-1">
                <a
                  href="/#training"
                  onClick={onClose}
                  className="inline-flex items-center gap-1 px-3 py-1 bg-amber-200/80 hover:bg-amber-300 text-amber-950 font-semibold rounded text-xs transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Navigate to Training Module
                </a>
              </div>
            </div>
          </div>
        )}

        {isRoleBlocked && !isTrainingBlocked && (
          <div role="alert" className="p-4 bg-red-50 border-b border-red-200 flex items-start gap-3 text-xs text-red-900">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              Your role ({user?.role}) is not permitted to sign with this meaning. Ask a colleague whose role is permitted, or an Administrator.
            </p>
          </div>
        )}

        {catalogError && (
          <div role="alert" className="p-4 bg-amber-50 border-b border-amber-200 flex items-start gap-3 text-xs text-amber-900">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              {catalogError} The text shown below may differ from the one the server records; the server applies its own checks to the signature either way.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-6 space-y-4.5">
          {/* Signer Identity Manifestation (21 CFR §11.50) */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200/80 pb-2.5">
              <div className="flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-blue-600" />
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Authenticated Signer</span>
              </div>
              <span className="px-2 py-0.5 bg-blue-100 text-blue-800 font-semibold text-xs rounded border border-blue-200">
                {user?.role || 'Authorized Signer'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-slate-500 block">Printed Name:</span>
                <span className="font-semibold text-slate-900 text-sm">{user?.name || 'Dr. Authorized Signer'}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Signer User ID / Email:</span>
                <span className="font-mono text-slate-700 truncate block" title={user?.email || user?.id}>
                  {user?.email || user?.id || 'authorized.user@pharma.org'}
                </span>
              </div>
            </div>

            {/* Target Record & Action Details */}
            <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Meaning of Signature:</span>
                <span className="font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-100">
                  {effectiveMeaning}
                </span>
              </div>

              {entityName && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-slate-500 shrink-0">Target Entity:</span>
                  <span className="font-mono font-medium text-slate-800 text-end truncate" title={entityName}>
                    {entityName}
                  </span>
                </div>
              )}

              {recordVersion !== undefined && (
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Bound Record Version:</span>
                  <span className="font-mono font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
                    Version #{recordVersion}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                <span className="text-slate-500 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-slate-400" /> Contemporary Time:
                </span>
                <div className="text-end">
                  <div className="font-medium text-slate-900">{dateLocalStr} {timeLocalStr}</div>
                  <div className="text-[10px] font-mono text-slate-400">{timeUtcStr}</div>
                </div>
              </div>
            </div>
          </div>

          {children}

          {/* Reason for Signature (ALCOA+ Mandatory for Rejections / OOS) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <span>Reason / Scientific Justification</span>
                {isReasonMandatory ? (
                  <span className="text-red-500 font-bold">* (Required)</span>
                ) : (
                  <span className="text-slate-400 font-normal">(Optional)</span>
                )}
              </label>
              {reason.length > 0 && (
                <span className={`text-[11px] font-mono ${reason.length < 5 && isReasonMandatory ? 'text-red-500 font-bold' : 'text-slate-400'}`}>
                  {reason.length} chars
                </span>
              )}
            </div>
            <textarea
              required={isReasonMandatory}
              disabled={isTrainingBlocked || isRoleBlocked || submitting}
              rows={2}
              placeholder={isReasonMandatory ? 'Document regulatory or analytical justification (min 5 chars)...' : 'Enter signing rationale or remarks...'}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 focus:border-blue-600 outline-none text-xs text-slate-800 resize-none transition-shadow disabled:bg-slate-100 disabled:cursor-not-allowed"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>

          {/* Re-Authentication: Secret Password Entry (21 CFR §11.200) */}
          <div className="space-y-1">
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-slate-500" />
                <span>Re-enter Password to Authenticate *</span>
              </label>
              {capsLockActive && (
                <span className="text-[10px] font-bold text-amber-600 flex items-center gap-1 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                  <AlertTriangle className="w-3 h-3" /> CAPS LOCK IS ON
                </span>
              )}
            </div>

            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                autoFocus
                disabled={isTrainingBlocked || isRoleBlocked || submitting}
                placeholder="Enter your confidential account password"
                className="w-full ps-3.5 pe-10 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 focus:border-blue-600 outline-none text-sm text-slate-900 transition-shadow disabled:bg-slate-100 disabled:cursor-not-allowed"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => setCapsLockActive(e.getModifierState && e.getModifierState('CapsLock'))}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword(!showPassword)}
                className="absolute end-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            
            <p className="text-[11px] text-slate-500 flex items-center gap-1 pt-1">
              <Lock className="w-3 h-3 text-slate-400" />
              Per GxP policy: 3 consecutive wrong attempts lock signing for a set time (15 minutes by default). Signing in is not affected.
            </p>
          </div>

          {/* Second factor (21 CFR §11.200(a)(1)): a user with an authenticator signs with the password and a current code */}
          {mfaRequired && (
            <div className="space-y-1">
              <label htmlFor={totpId} className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <Fingerprint className="w-3.5 h-3.5 text-slate-500" />
                <span>Authenticator Code (6 digits) *</span>
              </label>
              <input
                id={totpId}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                disabled={isTrainingBlocked || isRoleBlocked || submitting}
                placeholder="123456"
                className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-600 focus:border-blue-600 outline-none text-sm font-mono tracking-widest text-slate-900 transition-shadow disabled:bg-slate-100 disabled:cursor-not-allowed"
                value={totpCode}
                onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <p className="text-[11px] text-slate-500">A code can be used once. If you signed in with this code a moment ago, wait for the next one.</p>
            </div>
          )}

          {/* Cryptographic Seal Preview (21 CFR §11.70) */}
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg flex items-center gap-2.5">
            <Fingerprint className="w-4 h-4 text-indigo-600 shrink-0" />
            <div className="min-w-0 flex-1">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide block">
                Deterministic SHA-256 Digital Fingerprint
              </span>
              <span className="font-mono text-[10px] text-slate-600 truncate block" title={cryptoFingerprint}>
                {cryptoFingerprint || 'Generating cryptographic record hash...'}
              </span>
            </div>
          </div>

          {/* 21 CFR §11.100 Legal Affirmation Statement */}
          <div className="p-3 bg-blue-50/70 border border-blue-200/80 rounded-xl space-y-2">
            <label htmlFor={affirmationId} className="flex items-start gap-2.5 cursor-pointer">
              <input
                id={affirmationId}
                type="checkbox"
                required
                disabled={isTrainingBlocked || isRoleBlocked || submitting}
                checked={affirmed}
                onChange={e => setAffirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              <span className="text-xs text-slate-800 leading-snug">
                I hereby certify pursuant to <strong>21 CFR Part 11</strong> and <strong>EU GMP Annex 11</strong> that I am the authorized individual executing this action, and this electronic signature is the legally binding equivalent of my handwritten signature.
              </span>
            </label>
          </div>

          {/* Error Message Feedback */}
          {errorMessage && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-xs text-red-800 animate-in fade-in">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <div className="flex-1 font-medium">{errorMessage}</div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-slate-100 text-slate-700 font-semibold text-sm rounded-lg hover:bg-slate-200 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isTrainingBlocked || isRoleBlocked || submitting || !affirmed || !password || !totpComplete || (isReasonMandatory && reason.trim().length < 5)}
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Execute Signature</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

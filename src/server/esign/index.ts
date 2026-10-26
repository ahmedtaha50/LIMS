/** The electronic signature service (roadmap M07). Other tracks import from here only. */
export { signRecord, type SignRecordInput, type SignatureView, type AuditChange } from './signRecord';
export { authorizeSigner, type SigningCredentials, type AuthMethod } from './authorize';
export { registerSignable, getSignable, signableTypes, asSigned, type SignableEntity, type SignedChange, type CanonicalInput } from './registry';
export { getMeaning, listActiveMeanings, type Meaning } from './meanings';
export { verifySignature, bindingOf, type Verification, type VerifyStatus } from './verify';
export { canonicalJson, signatureContentHash, SIGNATURE_HASH_VERSION } from './hash';
import './entities';

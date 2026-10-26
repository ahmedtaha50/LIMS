/**
 * The scopes of an API client (roadmap M22). A scope is the only permission a machine principal has: the route registry
 * (./registry.ts) names the one scope each operation needs, and a token without it gets 403 INSUFFICIENT_SCOPE.
 * There is deliberately no scope for anything that is signed (review, approval, release, closure): an e-signature is made by a
 * person, so no token can ever be granted one.
 */
export const API_SCOPES = [
  { scope: 'samples:read', description: 'List samples and read a sample with its results (ids, limits and record versions).' },
  { scope: 'samples:write', description: 'Register samples against the specification in force (up to 500 in one call).' },
  { scope: 'results:write', description: 'Enter result values on samples in Testing (up to 500 in one call), under the same rules as entry at the bench.' },
  { scope: 'specifications:read', description: 'Read the specification in force for a material.' },
  { scope: 'batches:read', description: 'Read the disposition of a batch: released or on hold, and what blocks its release.' },
] as const;

export type ApiScope = (typeof API_SCOPES)[number]['scope'];
export const API_SCOPE_NAMES: readonly ApiScope[] = API_SCOPES.map(s => s.scope);
export const isApiScope = (v: unknown): v is ApiScope => typeof v === 'string' && (API_SCOPE_NAMES as readonly string[]).includes(v);

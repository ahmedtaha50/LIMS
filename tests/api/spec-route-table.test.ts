/**
 * Roadmap M11 (r1-spec): GATE CHECK. The route table (src/server/authz/routeTable.ts, r1-authz's file) decides which body keys
 * reach a route. The specification routes need it to list the keys of this track's schemas; docs/changes/r1-spec.gate.patch makes
 * that edit. This file FAILS until the patch is applied, and passes after: it is how the gate knows the patch was not forgotten.
 * (tests/api/spec-lifecycle.test.ts and spec-resolve.test.ts set the same two entries themselves so the routes can be tested before
 * the patch is applied.)
 */
import { describe, expect, it } from 'vitest';
import { ROUTE_RULES } from '../../src/server/authz/routeTable';
import * as v from '../../src/lib/validations/specifications';

describe('the route table lists the specification routes with this track\'s schemas', () => {
  const body = (route: string) => (ROUTE_RULES[route] as { body?: unknown }).body;

  it('POST /specifications', () => expect(body('POST /specifications')).toBe(v.specificationSchema));
  it('PUT /specifications/:id', () => expect(body('PUT /specifications/:id')).toBe(v.specificationUpdateSchema));
  it('POST /specifications/:id/approve', () => expect(body('POST /specifications/:id/approve')).toBe(v.specificationApproveSchema));
  it('keeps the permission, the state guard and the independence rule of the approval', () => {
    expect(ROUTE_RULES['POST /specifications/:id/approve']).toMatchObject({
      kind: 'perm', permission: 'spec.approve',
      state: { entity: 'specification', param: 'id', require: 'transition', to: 'Active' },
      sod: { rule: 'spec.approve', param: 'id' },
    });
  });
});

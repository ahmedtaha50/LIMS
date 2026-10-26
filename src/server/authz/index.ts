/** The authorisation layer: one table, applied as middleware, with a boot-time contract. See ./routeTable.ts. */
export { authorize } from './middleware';
export { assertRouteContract, findContractViolations } from './contract';
export { permissionsOfRole } from './grants';
export { assertIndependent, assertIndependentOfRecord } from './sod';

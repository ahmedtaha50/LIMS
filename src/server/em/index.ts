/** The environmental monitoring programme (roadmap M32, r2-em). Other tracks import from here only. */
export { approvedProfile, findBatchEmResults, impactedBatches, judge, openExcursion, type BatchEmView } from './engine';
export { evaluateTrends, findTrends, type TrendFinding } from './trends';
export { emProtections } from './protections';
export * from './constants';
import './entities';

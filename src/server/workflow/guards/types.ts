import type { Executor } from '../../core/tx';

export interface GuardedSample { id: string; state: string; batch: string; material: string }

/** One rule a sample transition must satisfy. `check` returns null when the rule is met, or the reason it is not. */
export interface TransitionGuard {
  name: string;
  check(ex: Executor, sample: GuardedSample): Promise<string | null>;
}

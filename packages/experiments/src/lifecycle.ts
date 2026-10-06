import { InvalidTransitionError, type ExperimentStatus } from '@aoc/core';

/**
 * Allowed lifecycle transitions. Everything not listed is rejected, so a
 * bug cannot, say, move a FAILED experiment straight to
 * READY_FOR_LIVE_REVIEW.
 */
export const TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  DISCOVERED: ['RESEARCHING', 'FAILED', 'ARCHIVED'],
  RESEARCHING: ['PROTOTYPE', 'FAILED', 'PAUSED', 'ARCHIVED'],
  PROTOTYPE: ['BACKTESTING', 'FAILED', 'PAUSED', 'ARCHIVED'],
  BACKTESTING: ['EVALUATING', 'FAILED', 'PAUSED', 'ARCHIVED'],
  EVALUATING: ['PAPER', 'PROMISING', 'PROBATION', 'READY_FOR_LIVE_REVIEW', 'FAILED', 'PAUSED', 'ARCHIVED'],
  PAPER: ['EVALUATING', 'FAILED', 'PAUSED', 'ARCHIVED'],
  PROMISING: ['EVALUATING', 'PAPER', 'PROBATION', 'FAILED', 'PAUSED', 'ARCHIVED'],
  PROBATION: ['PAPER', 'EVALUATING', 'BACKTESTING', 'FAILED', 'PAUSED', 'ARCHIVED'],
  READY_FOR_LIVE_REVIEW: ['EVALUATING', 'PROBATION', 'PAPER', 'FAILED', 'PAUSED', 'ARCHIVED'],
  PAUSED: ['RESEARCHING', 'PROTOTYPE', 'BACKTESTING', 'PAPER', 'EVALUATING', 'PROBATION', 'PROMISING', 'READY_FOR_LIVE_REVIEW', 'FAILED', 'ARCHIVED'],
  FAILED: ['ARCHIVED', 'RESEARCHING'],
  ARCHIVED: ['RESEARCHING'],
};

/** Statuses in which the paper engine accepts automated orders for an experiment. */
export const PAPER_TRADING_STATUSES: readonly ExperimentStatus[] = ['PAPER', 'PROMISING', 'PROBATION', 'READY_FOR_LIVE_REVIEW'];

/** Statuses the automated pipeline advances on its own. */
export const PIPELINE_STATUSES: readonly ExperimentStatus[] = ['DISCOVERED', 'RESEARCHING', 'PROTOTYPE', 'BACKTESTING', 'EVALUATING', 'PAPER', 'PROMISING', 'PROBATION', 'READY_FOR_LIVE_REVIEW'];

/** Transitions only a human may make (never the pipeline). */
export const MANUAL_ONLY: ReadonlyArray<[ExperimentStatus, ExperimentStatus]> = [
  ['FAILED', 'RESEARCHING'],
  ['ARCHIVED', 'RESEARCHING'],
];

export function canTransition(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExperimentStatus, to: ExperimentStatus, actor: 'PIPELINE' | 'USER' = 'PIPELINE'): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  if (actor === 'PIPELINE' && MANUAL_ONLY.some(([a, b]) => a === from && b === to)) {
    throw new InvalidTransitionError(from, to, 'only a human may revive a failed or archived experiment');
  }
}

/** Status to return to when an experiment is resumed from PAUSED. */
export function resumeTarget(statusBeforePause: ExperimentStatus | null): ExperimentStatus {
  if (statusBeforePause && statusBeforePause !== 'PAUSED' && canTransition('PAUSED', statusBeforePause)) return statusBeforePause;
  return 'RESEARCHING';
}

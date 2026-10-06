import { Decimal, d, type DecimalLike } from '@aoc/core';

export interface AllocationRequest {
  totalPaperCapital: DecimalLike;
  /** Capital already allocated to other active paper accounts. */
  allocated: DecimalLike;
  requested: DecimalLike;
  experimentMaxCapital: DecimalLike;
}

export interface AllocationDecision {
  approved: boolean;
  amount: Decimal;
  reasons: string[];
  remainingAfter: Decimal;
}

/**
 * Paper capital is a budget, not an infinite tap: allocations across all
 * experiments may not exceed the configured paper fund, and no experiment may
 * receive more than its own max-capital limit.
 */
export function decideAllocation(req: AllocationRequest): AllocationDecision {
  const total = d(req.totalPaperCapital);
  const used = d(req.allocated);
  const want = d(req.requested);
  const cap = d(req.experimentMaxCapital);
  const reasons: string[] = [];
  if (want.lte(0)) reasons.push('requested allocation must be positive');
  if (want.gt(cap)) reasons.push(`requested ${want.toFixed(2)} exceeds the experiment max capital ${cap.toFixed(2)}`);
  const free = total.minus(used);
  if (want.gt(free)) reasons.push(`requested ${want.toFixed(2)} exceeds the unallocated paper fund ${free.toFixed(2)}`);
  const approved = reasons.length === 0;
  return { approved, amount: approved ? want : new Decimal(0), reasons, remainingAfter: approved ? free.minus(want) : free };
}

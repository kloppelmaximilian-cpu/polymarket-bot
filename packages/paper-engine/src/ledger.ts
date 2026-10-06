import { Decimal, d, type DecimalLike } from '@aoc/core';

export interface LedgerCheck {
  ok: boolean;
  ledgerCash: Decimal;
  accountCash: Decimal;
  problems: string[];
}

/**
 * Verify a ledger independently of the engine that produced it:
 *   - sequence numbers are 1..n without gaps
 *   - every balanceAfter equals the running sum
 *   - the final balance equals the account's cash
 */
export function verifyLedger(transactions: ReadonlyArray<{ seq: number; amount: DecimalLike; balanceAfter: DecimalLike }>, accountCash: DecimalLike): LedgerCheck {
  const problems: string[] = [];
  const sorted = [...transactions].sort((a, b) => a.seq - b.seq);
  let running = new Decimal(0);
  sorted.forEach((t, i) => {
    if (t.seq !== i + 1) problems.push(`sequence gap: expected ${i + 1}, found ${t.seq}`);
    running = running.plus(d(t.amount));
    if (!running.eq(d(t.balanceAfter))) problems.push(`seq ${t.seq}: balanceAfter ${d(t.balanceAfter).toString()} != running ${running.toString()}`);
  });
  const cash = d(accountCash);
  if (!running.eq(cash)) problems.push(`ledger sum ${running.toString()} != account cash ${cash.toString()}`);
  return { ok: problems.length === 0, ledgerCash: running, accountCash: cash, problems };
}

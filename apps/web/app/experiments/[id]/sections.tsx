import Link from 'next/link';
import { Bars, DrawdownChart, EquityChart, FanChart, Tornado, type FanRow } from '@/components/charts';
import { ActionButton, ActionForm, Field, Submit } from '@/components/forms';
import { Badge, Card, Empty, KeyValues, NoData, Notice, Pnl, ProvenanceBadge, ScoreBar, Table, Td, Th, clsx } from '@/components/ui';
import { createVersion, promoteVersion, updateCompliance, updateRiskLimits } from '@/lib/actions';
import { COMPLIANCE_STATES } from '@/lib/constants';
import { ago, dateTime, humanize, num, pct, score, toNum, usd } from '@/lib/format';
import type { ExperimentDetail, Versions } from '@/lib/types';

type Run = ExperimentDetail['latestRuns'][string];
type Summary = Record<string, unknown>;

const s = (run: Run | undefined): Summary => (run?.summary ?? {}) as Summary;
const r = (run: Run | undefined): Summary => (run?.result ?? {}) as Summary;

interface GateSummary {
  gate: string;
  passed: boolean;
  blocking: string[];
  checks: Array<{ id: string; label: string; passed: boolean | null; value: number | string | null; threshold: number | string | null; required: boolean }>;
}

// ──────────────────────────────────────────────────────────────── score ──

export function ScoreSection({ d }: { d: ExperimentDetail }) {
  const latest = d.scoreHistory[0];
  if (!latest) {
    return (
      <Card title="Opportunity score">
        <Empty title="Not scored yet">Scores are computed after the first backtest or business simulation.</Empty>
      </Card>
    );
  }
  const exp = (latest.explanation ?? {}) as { caps?: string[]; explanation?: string[]; riskMultiplier?: number; labels?: Record<string, string> };
  const comps = latest.components as Record<string, number | null>;
  const LABELS: Record<string, string> = { profit: 'Profit', risk: 'Risk (higher = safer)', automation: 'Automation', scalability: 'Scalability', capitalEfficiency: 'Capital efficiency', reliability: 'Reliability', timeToRevenue: 'Time to revenue', context: 'Context' };
  const history = d.scoreHistory
    .slice()
    .reverse()
    .map((h) => ({ ts: new Date(h.computedAt).getTime(), value: h.overall }));
  return (
    <Card title="Opportunity score" subtitle={`computed ${ago(latest.computedAt)} · rank ${latest.rank ? `#${latest.rank}` : '—'}`} actions={<ProvenanceBadge provenance={latest.evidence} />}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="num text-4xl font-semibold">{score(latest.overall)}</div>
        <div className="text-xs text-muted">
          <div>
            confidence <strong className="text-text">{latest.confidence}</strong>
          </div>
          <div>risk multiplier {num(exp.riskMultiplier, 3)}</div>
        </div>
      </div>
      <div className="mt-4 grid gap-1.5">
        {Object.entries(comps).map(([k, v]) => (
          <div key={k} className="grid grid-cols-[10rem_1fr] items-center gap-3 text-[13px]">
            <span className="text-muted">{LABELS[k] ?? k}</span>
            {v === null ? <NoData /> : <ScoreBar value={v} small />}
          </div>
        ))}
      </div>
      {exp.caps?.length ? (
        <div className="mt-4">
          <Notice tone="amber" title="Caps applied">
            <ul className="list-disc pl-4">
              {exp.caps.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}
      {exp.explanation?.length ? (
        <ul className="mt-3 list-disc space-y-0.5 pl-4 text-xs text-muted">
          {exp.explanation.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {history.length > 1 ? (
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Score history</div>
          <EquityChart points={history} height={120} label="Score" />
        </div>
      ) : null}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────── gates ──

export function GatesSection({ d }: { d: ExperimentDetail }) {
  const ev = (d.experiment.evaluation ?? {}) as Record<string, unknown>;
  const gates = (['prePaper', 'promising', 'liveReview'] as const).map((k) => [k, ev[k] as GateSummary | undefined] as const).filter(([, g]) => !!g);
  const notes = (ev.dataNotes as string[] | undefined) ?? [];
  return (
    <Card title="Quality gates" subtitle="A strategy must pass these before paper testing, PROMISING, or a manual live review. Lucky streaks are filtered by minimum sample sizes, out-of-sample checks and the deflated Sharpe ratio.">
      {d.experiment.failureReasons.length ? (
        <div className="mb-3">
          <Notice tone="red" title="Failure reasons">
            {d.experiment.failureReasons.map((f) => humanize(f)).join(', ')} — {d.experiment.statusReason}
          </Notice>
        </div>
      ) : null}
      {gates.length === 0 ? (
        <Empty title="No gate evaluated yet" />
      ) : (
        <div className="space-y-4">
          {gates.map(([k, g]) => (
            <div key={k}>
              <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
                {humanize(g!.gate)} gate <Badge tone={g!.passed ? 'green' : 'amber'}>{g!.passed ? 'passed' : 'not passed'}</Badge>
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Check</Th>
                    <Th>Value</Th>
                    <Th>Threshold</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {g!.checks.map((c) => (
                    <tr key={c.id}>
                      <Td>
                        {c.label}
                        {c.required ? <span className="ml-1 text-[10px] text-muted">(required)</span> : null}
                      </Td>
                      <Td className="num">{c.value === null ? <NoData /> : typeof c.value === 'number' ? num(c.value, 3) : c.value}</Td>
                      <Td className="num text-muted">{c.threshold === null ? '—' : typeof c.threshold === 'number' ? num(c.threshold, 3) : c.threshold}</Td>
                      <Td>{c.passed === null ? <Badge tone="gray">no evidence</Badge> : c.passed ? <Badge tone="green">pass</Badge> : <Badge tone="red">fail</Badge>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ))}
        </div>
      )}
      {toNum(ev.dsr) !== null ? <p className="mt-3 text-xs text-muted">Deflated Sharpe ratio (probability the Sharpe is real after {String((ev.labTrials as number | undefined) ?? 1)} trial(s)): {pct(ev.dsr)}</p> : null}
      {notes.length ? (
        <ul className="mt-2 list-disc pl-4 text-xs text-muted">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ──────────────────────────────────────────────────── finance results ──

export function BacktestSection({ d }: { d: ExperimentDetail }) {
  const bt = d.latestRuns.BACKTEST;
  if (!bt) {
    return (
      <Card title="Backtest">
        <Empty title="No data">The backtest suite has not run for the current version yet.</Empty>
      </Card>
    );
  }
  const sm = s(bt);
  const res = r(bt);
  const equity = ((res.equityCurve as Array<{ ts: number; equity: number }> | undefined) ?? []).map((p) => ({ ts: p.ts, value: p.equity }));
  const trades = (res.trades as Array<Record<string, unknown>> | undefined) ?? [];
  const notes = (res.notes as string[] | undefined) ?? [];
  const train = sm.train as Summary | null;
  const test = sm.test as Summary | null;
  const metricRows = (m: Summary): Array<[string, React.ReactNode]> => [
    ['Trades', num(m.trades, 0)],
    ['Net profit', <Pnl key="np" value={m.netProfit} format={(v) => usd(v, { signed: true })} />],
    ['Total return', <Pnl key="tr" value={m.totalReturnPct} format={(v) => pct(v, { signed: true })} />],
    ['Win rate', pct(m.winRate)],
    ['Profit factor', num(m.profitFactor)],
    ['Expectancy / trade', usd(m.expectancy)],
    ['Sharpe (annualised)', num(m.sharpe)],
    ['Sortino', num(m.sortino)],
    ['Max drawdown', pct(m.maxDrawdownPct)],
    ['Fees paid', usd(m.fees)],
  ];
  return (
    <Card title="Backtest" subtitle={`seed ${bt.seed} · ${dateTime(bt.createdAt)} · executed at the next bar's open, fees and slippage included`} actions={<ProvenanceBadge provenance={bt.provenance} />}>
      {bt.provenance === 'DEMO' ? (
        <div className="mb-3">
          <Notice tone="purple" title="DEMO data">
            This backtest ran on synthetic data because real market data was unavailable. It shows that the code works — not that the strategy has an edge. It never counts as profit evidence.
          </Notice>
        </div>
      ) : null}
      <EquityChart points={equity} baseline={equity[0]?.value} />
      <DrawdownChart points={equity} height={110} />
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Full period</div>
          <KeyValues rows={metricRows(sm)} />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Train (first 70 %)</div>
          {train ? <KeyValues rows={metricRows(train)} /> : <NoData />}
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Test / out of sample (last 30 %)</div>
          {test ? <KeyValues rows={metricRows(test)} /> : <NoData />}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        Capacity estimate: {sm.capacityUsd === null || sm.capacityUsd === undefined ? 'NO DATA' : usd(sm.capacityUsd)} · gross expectancy per trade (before costs): {usd(sm.grossExpectancy)}
      </p>
      {notes.length ? (
        <ul className="mt-2 list-disc pl-4 text-xs text-muted">
          {notes.slice(0, 8).map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {trades.length ? (
        <details className="mt-4">
          <summary className="text-[13px] font-medium text-accent">Trades ({trades.length} shown)</summary>
          <Table className="mt-2 max-h-80">
            <thead>
              <tr>
                <Th>Exit</Th>
                <Th>Symbol</Th>
                <Th>Dir.</Th>
                <Th>Entry</Th>
                <Th>Exit price</Th>
                <Th>Qty</Th>
                <Th>Fees</Th>
                <Th>Net P&amp;L</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={String(t.id)}>
                  <Td className="text-xs whitespace-nowrap">{dateTime(t.exitTs as number)}</Td>
                  <Td className="text-xs">{String(t.symbol)}</Td>
                  <Td className="text-xs">{String(t.direction)}</Td>
                  <Td className="num text-xs">{num(t.entryPrice, 4)}</Td>
                  <Td className="num text-xs">{num(t.exitPrice, 4)}</Td>
                  <Td className="num text-xs">{num(t.quantity, 6)}</Td>
                  <Td className="num text-xs">{usd(t.fees)}</Td>
                  <Td className="text-xs">
                    <Pnl value={t.netPnl} format={(v) => usd(v, { signed: true })} />
                  </Td>
                  <Td className="text-xs text-muted">{String(t.reason ?? '')}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </details>
      ) : null}
    </Card>
  );
}

export function RobustnessSection({ d }: { d: ExperimentDetail }) {
  const wf = d.latestRuns.WALK_FORWARD;
  const mc = d.latestRuns.MONTE_CARLO;
  const sens = d.latestRuns.SENSITIVITY;
  const lab = d.latestRuns.LAB;
  if (!wf && !mc && !sens && !lab) return null;
  const folds = ((r(wf).folds as Array<Record<string, unknown>> | undefined) ?? []).map((f, i) => ({ label: `F${i + 1}`, value: toNum(f.totalReturnPct) ?? 0 }));
  const oos = ((r(wf).oosEquity as Array<{ ts: number; equity: number }> | undefined) ?? []).map((p) => ({ ts: p.ts, value: p.equity }));
  const cost = (r(sens).cost as Array<{ multiplier: number; netProfit: number }> | undefined) ?? [];
  const params = (r(sens).params as Array<{ param: string; value: unknown; netProfit: number }> | undefined) ?? [];
  const m = s(mc);
  return (
    <Card title="Robustness" subtitle="Walk-forward (parameters fixed), Monte Carlo, cost and parameter sensitivity — the checks against overfitting and lucky streaks">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
            Walk-forward {wf ? <ProvenanceBadge provenance={wf.provenance} /> : null}
          </div>
          {wf ? (
            <>
              <p className="mb-2 text-xs text-muted">
                {String(s(wf).profitableFolds)} of {String(s(wf).folds)} folds profitable · stitched out-of-sample return {pct(s(wf).totalReturnPct, { signed: true })}, max DD {pct(s(wf).maxDrawdownPct)}
              </p>
              <Bars rows={folds} format="pct" height={160} />
              {oos.length > 1 ? <EquityChart points={oos} height={140} label="OOS equity" /> : null}
            </>
          ) : (
            <NoData />
          )}
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
            Monte Carlo {mc ? <ProvenanceBadge provenance={mc.provenance} /> : null}
          </div>
          {mc ? (
            <KeyValues
              rows={[
                ['Method', `${humanize(String(m.method))} · ${num(m.paths, 0)} paths of ${num(m.sampleSize, 0)}`],
                ['Total return P5 / P50 / P95', `${pct(m.totalReturnP5)} / ${pct(m.totalReturnP50)} / ${pct(m.totalReturnP95)}`],
                ['Probability of a loss', pct(m.probLoss)],
                ['Max drawdown P50 / P95', `${pct(m.maxDrawdownP50)} / ${pct(m.maxDrawdownP95)}`],
                [`P(drawdown > ${pct(m.drawdownLimit, { digits: 0 })})`, pct(m.probDrawdownBeyondLimit)],
              ]}
            />
          ) : (
            <NoData />
          )}
          <div className="mt-5 mb-1 text-[13px] font-semibold">Cost sensitivity</div>
          {cost.length ? (
            <>
              <Bars rows={cost.map((c) => ({ label: `${c.multiplier}× costs`, value: c.netProfit }))} format="usd" height={140} />
              <p className="text-xs text-muted">
                Break-even at {s(sens).costBreakEvenMultiplier === null ? 'no multiplier in range' : `${num(s(sens).costBreakEvenMultiplier)}× costs`} · profitable at 1.5× costs: {s(sens).profitableAt1_5x ? 'yes' : 'no'}
              </p>
            </>
          ) : (
            <NoData />
          )}
        </div>
      </div>
      {params.length ? (
        <div className="mt-5">
          <div className="mb-1 text-[13px] font-semibold">Parameter neighbourhood (stability {pct(s(sens).paramStability, { digits: 0 })})</div>
          <Table>
            <thead>
              <tr>
                <Th>Parameter</Th>
                <Th>Value</Th>
                <Th>Net profit</Th>
              </tr>
            </thead>
            <tbody>
              {params.map((p, i) => (
                <tr key={i}>
                  <Td className="font-mono text-xs">{p.param}</Td>
                  <Td className="num text-xs">{String(p.value)}</Td>
                  <Td className="text-xs">
                    <Pnl value={p.netProfit} format={(v) => usd(v, { signed: true })} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
      {lab ? (
        <div className="mt-5">
          <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
            Strategy Lab <Badge tone={s(lab).recommend ? 'green' : 'gray'}>{s(lab).recommend ? 'recommends a candidate' : 'no change recommended'}</Badge>
          </div>
          <ul className="list-disc pl-4 text-xs text-muted">
            {((s(lab).reasons as string[] | undefined) ?? []).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">
            {num(s(lab).trials, 0)} variant(s) this run, {num(s(lab).totalTrials, 0)} in total (counted in the deflated Sharpe). Variants are chosen on the training window and judged out of sample — no blind fitting.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────── business results ──

export function SimulationSection({ d }: { d: ExperimentDetail }) {
  const sim = d.latestRuns.SIMULATION;
  if (!sim) {
    return (
      <Card title="Business simulation">
        <Empty title="No data">The Monte Carlo estimate has not run for the current version yet.</Empty>
      </Card>
    );
  }
  const sm = s(sim);
  const res = r(sim);
  const p = (k: string) => (sm[k] ?? {}) as { p10?: number; p50?: number; p90?: number };
  const months = (res.months as Array<{ month: number; cumulativeCash: FanRow; profit: FanRow; mrr: FanRow; customers: FanRow }> | undefined) ?? [];
  const sensitivity = (res.sensitivity as Array<{ label: string; profitAtLow: number; profitAtHigh: number }> | undefined) ?? [];
  const notes = (res.notes as string[] | undefined) ?? [];
  const verified = toNum(sm.verifiedAssumptionShare);
  return (
    <Card title="Business simulation" subtitle={`${num(sm.runs, 0)} Monte Carlo scenarios over ${num(sm.horizonMonths, 0)} months · seed ${sim.seed}`} actions={<ProvenanceBadge provenance={sim.provenance} />}>
      <Notice tone="amber" title="Estimate, not observation">
        Every number here follows from the assumptions below{verified !== null ? ` (${pct(verified, { digits: 0 })} of them backed by a source)` : ''}. Verify the assumptions before trusting the result.
      </Notice>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Cumulative cash (P10 … P90, median)</div>
          <FanChart rows={months.map((m) => ({ month: m.month, p10: m.cumulativeCash.p10, p50: m.cumulativeCash.p50, p90: m.cumulativeCash.p90 }))} label="Cash" />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Monthly profit (P10 … P90, median)</div>
          <FanChart rows={months.map((m) => ({ month: m.month, p10: m.profit.p10, p50: m.profit.p50, p90: m.profit.p90 }))} label="Profit" />
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <KeyValues
          rows={[
            ['Cumulative profit P10 / P50 / P90', `${usd(p('cumulativeProfit').p10)} / ${usd(p('cumulativeProfit').p50)} / ${usd(p('cumulativeProfit').p90)}`],
            ['P(profitable at horizon)', pct(sm.probProfitableAtHorizon)],
            ['P(break-even within 12 months)', pct(sm.probBreakEvenWithin12m)],
            ['Break-even month (median)', sm.breakEvenMonthP50 === null ? 'not reached' : num(sm.breakEvenMonthP50, 0)],
            ['Stress case (conversion −30 %, costs +30 %)', usd(sm.stressedProfitP50)],
          ]}
        />
        <KeyValues
          rows={[
            ['Cash needed P50 / P90', `${usd(p('maxCashNeed').p50)} / ${usd(p('maxCashNeed').p90)}`],
            ['Simulated budget', usd(sm.budget)],
            ['Probability of ruin', pct(sm.probRuin)],
            ['LTV / CAC', num(sm.ltvToCac)],
            ['Revenue month 12 (median)', usd(p('revenueMonth12').p50)],
          ]}
        />
      </div>
      {sm.capitalNote ? <p className="mt-2 text-xs text-muted">{String(sm.capitalNote)}</p> : null}
      {sensitivity.length ? (
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Sensitivity: which assumption moves the result most</div>
          <Tornado rows={sensitivity.slice(0, 8).map((x) => ({ label: x.label, low: x.profitAtLow, high: x.profitAtHigh }))} base={p('cumulativeProfit').p50 ?? 0} />
        </div>
      ) : null}
      {notes.length ? (
        <ul className="mt-2 list-disc pl-4 text-xs text-muted">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

interface AssumptionRow {
  key: string;
  label: string;
  unit: string;
  low: number;
  mode: number;
  high: number;
  distribution: string;
  source: string | null;
  note?: string;
}

export function AssumptionsSection({ d }: { d: ExperimentDetail }) {
  const rows = ((d.currentVersion?.assumptions ?? d.experiment.assumptions) as AssumptionRow[]) ?? [];
  if (rows.length === 0) return null;
  return (
    <Card title="Assumptions" subtitle={`Version ${d.currentVersion?.label ?? '—'} · change them by creating a new version`} bodyClassName="p-0">
      <Table>
        <thead>
          <tr>
            <Th>Assumption</Th>
            <Th>Low</Th>
            <Th>Most likely</Th>
            <Th>High</Th>
            <Th>Unit</Th>
            <Th>Distribution</Th>
            <Th>Source</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.key}>
              <Td>
                {a.label}
                <div className="font-mono text-[11px] text-muted">{a.key}</div>
              </Td>
              <Td className="num">{num(a.low, 4)}</Td>
              <Td className="num font-semibold">{num(a.mode, 4)}</Td>
              <Td className="num">{num(a.high, 4)}</Td>
              <Td className="text-xs text-muted">{a.unit}</Td>
              <Td className="text-xs">{a.distribution}</Td>
              <Td className="max-w-xs text-xs">
                {a.source ? (
                  <a href={a.source} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">
                    {a.source}
                  </a>
                ) : (
                  <Badge tone="amber" title={a.note}>
                    unverified
                  </Badge>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────── paper ──

interface PaperSectionData {
  account: { id: string; provenance: string; status: string; isDemo: boolean; startingCapital: string; cash: string; simulatedDays: number; lastTickAt: string | null; createdAt: string };
  snapshot: Record<string, number | string | null>;
  positions: Array<{ id: string; venue: string; symbol: string; instrumentKind: string; quantity: string; avgPrice: string; markPrice: string | null; realizedPnl: string; openedAt: string }>;
  orders: Array<{ id: string; createdAt: string; symbol: string; side: string; type: string; status: string; quantity: string; limitPrice: string | null; filledQuantity: string; rejectReason: string | null; reason: string | null }>;
  transactions: Array<{ id: string; seq: number; ts: string; type: string; category: string | null; amount: string; balanceAfter: string; description: string | null }>;
  equityCurve: Array<{ ts: number; equity: number }>;
  stats: { days: number; simulatedDays: number; trades: number; netProfit: number; maxDrawdownPct: number; ordersTotal: number; ordersRejected: number; riskBreaches: number; dataUptime: number | null; winRate: number | null } | null;
  previousAccounts: Array<{ id: string; status: string; startingCapital: string; cash: string; createdAt: string }>;
}

export function PaperSection({ d }: { d: ExperimentDetail }) {
  const p = d.paper as unknown as PaperSectionData | null;
  if (!p) {
    return (
      <Card title="Paper test">
        <Empty title="No paper account">Paper testing starts after the experiment passes the pre-paper gate.</Empty>
      </Card>
    );
  }
  const sn = p.snapshot;
  const curve = p.equityCurve.map((x) => ({ ts: x.ts, value: x.equity }));
  const prov = p.account.isDemo ? 'DEMO' : p.account.provenance;
  return (
    <Card
      title={p.account.provenance === 'SIMULATED' ? 'Simulated operation' : 'Paper trading'}
      subtitle={p.account.provenance === 'SIMULATED' ? `${p.account.simulatedDays} simulated day(s) — virtual customers, virtual money` : `virtual money on live market data · account ${p.account.status.toLowerCase()} · last tick ${ago(p.account.lastTickAt)}`}
      actions={
        <span className="flex items-center gap-2">
          <ProvenanceBadge provenance={prov} />
          <Link href={`/portfolio/${p.account.id}`} className="text-xs text-accent hover:underline">
            full ledger
          </Link>
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        {(
          [
            ['Equity', usd(sn.equity)],
            ['Cash', usd(sn.cash)],
            ['Realized P&L', <Pnl key="r" value={sn.realizedPnl} format={(v) => usd(v, { signed: true })} />],
            ['Unrealized P&L', <Pnl key="u" value={sn.unrealizedPnl} format={(v) => usd(v, { signed: true })} />],
            ['Fees', usd(sn.feesPaid ?? sn.fees)],
            ['Exposure', usd(sn.exposure)],
            ['Drawdown', pct(sn.drawdownPct)],
            ['Open positions', num(sn.openPositions, 0)],
            ['Orders today', num(sn.ordersToday, 0)],
            ['Trades', num(p.stats?.trades, 0)],
            ['Win rate', pct(p.stats?.winRate)],
            ['Data uptime', pct(p.stats?.dataUptime)],
          ] as Array<[string, React.ReactNode]>
        ).map(([k, v]) => (
          <div key={k} className="rounded-md bg-surface-2 px-3 py-2">
            <div className="text-[10.5px] tracking-wider text-muted uppercase">{k}</div>
            <div className="num mt-0.5 text-[15px] font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <EquityChart points={curve} baseline={Number(p.account.startingCapital)} />
        <DrawdownChart points={curve} height={100} />
      </div>
      {p.positions.length ? (
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Positions</div>
          <Table>
            <thead>
              <tr>
                <Th>Venue</Th>
                <Th>Symbol</Th>
                <Th>Kind</Th>
                <Th>Qty</Th>
                <Th>Avg price</Th>
                <Th>Mark</Th>
                <Th>Realized</Th>
                <Th>Opened</Th>
              </tr>
            </thead>
            <tbody>
              {p.positions.map((x) => (
                <tr key={x.id}>
                  <Td className="text-xs">{x.venue}</Td>
                  <Td className="text-xs">{x.symbol}</Td>
                  <Td className="text-xs">{x.instrumentKind}</Td>
                  <Td className="num text-xs">{num(x.quantity, 6)}</Td>
                  <Td className="num text-xs">{num(x.avgPrice, 4)}</Td>
                  <Td className="num text-xs">{x.markPrice === null ? <NoData /> : num(x.markPrice, 4)}</Td>
                  <Td className="text-xs">
                    <Pnl value={x.realizedPnl} format={(v) => usd(v, { signed: true })} />
                  </Td>
                  <Td className="text-xs text-muted">{ago(x.openedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
      <details className="mt-4">
        <summary className="text-[13px] font-medium text-accent">Orders ({p.orders.length}) and ledger ({p.transactions.length} latest)</summary>
        <div className="mt-2 grid gap-4 xl:grid-cols-2">
          <Table className="max-h-96">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Symbol</Th>
                <Th>Side</Th>
                <Th>Type</Th>
                <Th>Qty</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {p.orders.map((o) => (
                <tr key={o.id}>
                  <Td className="text-xs whitespace-nowrap">{dateTime(o.createdAt)}</Td>
                  <Td className="text-xs">{o.symbol}</Td>
                  <Td className={clsx('text-xs font-semibold', o.side === 'BUY' ? 'text-positive' : 'text-negative')}>{o.side}</Td>
                  <Td className="text-xs">
                    {o.type}
                    {o.limitPrice ? ` @ ${num(o.limitPrice, 4)}` : ''}
                  </Td>
                  <Td className="num text-xs">
                    {num(o.filledQuantity, 6)} / {num(o.quantity, 6)}
                  </Td>
                  <Td className="text-xs" title={o.rejectReason ?? o.reason ?? undefined}>
                    <Badge tone={o.status === 'FILLED' ? 'green' : o.status === 'REJECTED' ? 'red' : o.status === 'CANCELLED' ? 'gray' : 'sky'}>{o.status}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Table className="max-h-96">
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Time</Th>
                <Th>Type</Th>
                <Th>Amount</Th>
                <Th>Balance</Th>
              </tr>
            </thead>
            <tbody>
              {p.transactions.map((t) => (
                <tr key={t.id} title={t.description ?? undefined}>
                  <Td className="num text-xs text-muted">{t.seq}</Td>
                  <Td className="text-xs whitespace-nowrap">{dateTime(t.ts)}</Td>
                  <Td className="text-xs">
                    {t.type}
                    {t.category ? <span className="text-muted"> · {t.category}</span> : null}
                  </Td>
                  <Td className="text-xs">
                    <Pnl value={t.amount} format={(v) => usd(v, { signed: true, digits: 2 })} />
                  </Td>
                  <Td className="num text-xs">{usd(t.balanceAfter, { digits: 2 })}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </details>
      {p.previousAccounts.length ? <p className="mt-3 text-xs text-muted">{p.previousAccounts.length} earlier account(s) from previous versions are closed and kept for the record.</p> : null}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── versions ──

export function VersionsSection({ d, versions }: { d: ExperimentDetail; versions: Versions }) {
  return (
    <Card title="Versions" subtitle="Every parameter or assumption change is a new immutable version (v1, v1.1, v2 …) — never an overwrite." className="scroll-mt-20">
      <div id="versions" />
      <Table>
        <thead>
          <tr>
            <Th>Version</Th>
            <Th>Status</Th>
            <Th>Change</Th>
            <Th>Parameters</Th>
            <Th>Result</Th>
            <Th>Score</Th>
            <Th>Created</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {versions
            .slice()
            .reverse()
            .map((v) => {
              const sm = (v.result?.summary ?? {}) as Summary;
              const profit = v.result ? (v.result.provenance === 'ESTIMATED' ? (sm.cumulativeProfit as { p50?: number } | undefined)?.p50 : sm.netProfit) : null;
              return (
                <tr key={v.version.id}>
                  <Td className="font-semibold">{v.version.label}</Td>
                  <Td>
                    <Badge tone={v.version.status === 'ACTIVE' ? 'green' : v.version.status === 'CANDIDATE' ? 'sky' : v.version.status === 'REJECTED' ? 'red' : 'gray'}>{v.version.status}</Badge>
                  </Td>
                  <Td className="max-w-xs text-xs">
                    {v.version.changeNote}
                    <div className="text-[11px] text-muted">by {v.version.createdBy}</div>
                  </Td>
                  <Td className="max-w-sm">
                    <code className="block truncate font-mono text-[11px] text-muted" title={JSON.stringify(v.version.params)}>
                      {JSON.stringify(v.version.params)}
                    </code>
                  </Td>
                  <Td className="text-xs whitespace-nowrap">
                    {v.result ? (
                      <span className="flex items-center gap-1.5">
                        <Pnl value={profit} format={(x) => usd(x, { signed: true })} /> <ProvenanceBadge provenance={v.result.provenance} />
                      </span>
                    ) : (
                      <NoData />
                    )}
                  </Td>
                  <Td className="num text-xs">{v.score ? `${score(v.score.overall)} (${v.score.confidence.toLowerCase()})` : <NoData />}</Td>
                  <Td className="text-xs whitespace-nowrap text-muted">{ago(v.version.createdAt)}</Td>
                  <Td>{v.version.status === 'CANDIDATE' ? <ActionButton action={promoteVersion} hidden={{ id: d.experiment.id, versionId: v.version.id }} confirm={`Promote ${v.version.label} to ACTIVE? The experiment is re-evaluated from a fresh backtest and its paper account is restarted.`}>Promote</ActionButton> : null}</Td>
                </tr>
              );
            })}
        </tbody>
      </Table>
      <details className="mt-4">
        <summary className="text-[13px] font-medium text-accent">Create a new version</summary>
        <ActionForm action={createVersion} hidden={{ id: d.experiment.id }} className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="Parameter changes (JSON, merged into the current parameters)" hint={`Current: ${JSON.stringify(d.currentVersion?.params ?? {})}`} className="md:col-span-2">
            <textarea name="params" rows={3} placeholder='{"lookbackBars": 48}' className="font-mono" />
          </Field>
          <Field label="Change note (required)">
            <input name="changeNote" required minLength={3} maxLength={1000} placeholder="why this change?" />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Bump">
              <select name="bump" defaultValue="minor">
                <option value="minor">minor (v1 → v1.1)</option>
                <option value="major">major (v1 → v2)</option>
              </select>
            </Field>
            <Field label="Status">
              <select name="status" defaultValue="CANDIDATE">
                <option value="CANDIDATE">CANDIDATE (compare first)</option>
                <option value="ACTIVE">ACTIVE (re-evaluate now)</option>
              </select>
            </Field>
            <Submit variant="primary">Create version</Submit>
          </div>
        </ActionForm>
      </details>
    </Card>
  );
}

// ───────────────────────────────────────────────── risk and compliance ──

const LIMIT_KEYS = ['maxCapital', 'maxDailyLoss', 'maxDrawdownPct', 'maxExposure', 'maxPositions', 'maxOrdersPerDay', 'maxOrderNotional', 'maxApiSpend', 'maxExperimentSpend'] as const;

export function RiskSection({ d }: { d: ExperimentDetail }) {
  const limits = d.riskLimits.limits as Record<string, number>;
  const labels = d.riskLimits.labels as Record<string, string>;
  const status = d.riskLimits.status ?? [];
  return (
    <Card title="Risk limits" subtitle="Enforced before every paper order and on every tick. A breach stops the experiment (PAUSED) and is logged.">
      {status.length ? (
        <div className="mb-4 space-y-1.5">
          {status.map((l) => (
            <div key={l.limit} className="grid grid-cols-[12rem_1fr_6rem] items-center gap-3 text-[13px]">
              <span className="text-muted">{l.label}</span>
              <span className="relative h-1.5 overflow-hidden rounded-full bg-surface-3">
                <span className={clsx('absolute inset-y-0 left-0 rounded-full', l.severity === 'INFO' ? 'bg-positive' : l.severity === 'WARNING' ? 'bg-warning' : 'bg-negative')} style={{ width: `${Math.min(100, l.utilization * 100)}%` }} />
              </span>
              <span className="num text-right text-xs">{pct(l.utilization, { digits: 0 })}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-3 text-xs text-muted">Utilisation appears once a paper account exists.</p>
      )}
      <ActionForm action={updateRiskLimits} hidden={{ id: d.experiment.id }} className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {LIMIT_KEYS.map((k) => (
          <Field key={k} label={labels[k] ?? k}>
            <input name={k} type="number" step="any" min={0} defaultValue={limits[k]} />
          </Field>
        ))}
        <div className="col-span-full">
          <Submit>Save limits</Submit>
        </div>
      </ActionForm>
      {d.riskEvents.length ? (
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Risk events</div>
          <ul className="space-y-1 text-xs">
            {d.riskEvents.slice(0, 10).map((e) => (
              <li key={e.id} className="flex gap-2">
                <Badge tone={e.severity === 'WARNING' ? 'amber' : e.severity === 'INFO' ? 'gray' : 'red'}>{e.severity}</Badge>
                <span>{e.message}</span>
                <span className="ml-auto whitespace-nowrap text-muted">{ago(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

export function ComplianceSection({ d }: { d: ExperimentDetail }) {
  return (
    <Card title="Compliance review" subtitle="Terms of service, API terms, licences, data rights, spam and platform rules, regulation. A BLOCKER fails the experiment. Nothing is auto-approved.">
      <Table>
        <thead>
          <tr>
            <Th>Item</Th>
            <Th>State</Th>
            <Th>Note</Th>
            <Th>Reviewed</Th>
          </tr>
        </thead>
        <tbody>
          {d.compliance.map((c) => (
            <tr key={c.item}>
              <Td className="text-xs">{humanize(c.item)}</Td>
              <Td>
                <Badge tone={c.state === 'OK' || c.state === 'NOT_APPLICABLE' ? 'green' : c.state === 'CONCERN' ? 'amber' : c.state === 'BLOCKER' ? 'red' : 'gray'}>{humanize(c.state)}</Badge>
              </Td>
              <Td className="max-w-md text-xs text-muted">{c.note || '—'}</Td>
              <Td className="text-xs whitespace-nowrap text-muted">{c.reviewedAt ? `${ago(c.reviewedAt)} by ${c.reviewer}` : '—'}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <details className="mt-3">
        <summary className="text-[13px] font-medium text-accent">Record a review</summary>
        <ActionForm action={updateCompliance} hidden={{ id: d.experiment.id }} className="mt-3 grid gap-3 md:grid-cols-4">
          <Field label="Item">
            <select name="item">
              {d.compliance.map((c) => (
                <option key={c.item} value={c.item}>
                  {humanize(c.item)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="State">
            <select name="state" defaultValue="OK">
              {COMPLIANCE_STATES.map((x) => (
                <option key={x} value={x}>
                  {humanize(x)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note" className="md:col-span-2">
            <input name="note" maxLength={2000} placeholder="what did you check?" />
          </Field>
          <div className="col-span-full">
            <Submit confirm="Record this compliance review? A BLOCKER fails the experiment.">Save review</Submit>
          </div>
        </ActionForm>
      </details>
    </Card>
  );
}

// ──────────────────────────────────────────────────────── runs and logs ──

export function RunsSection({ d }: { d: ExperimentDetail }) {
  return (
    <Card title="Runs" subtitle="Every backtest, simulation and lab run is stored with its seed and configuration (reproducible)." bodyClassName="p-0">
      {d.runs.length === 0 ? (
        <div className="p-4">
          <Empty title="No runs yet" />
        </div>
      ) : (
        <Table className="max-h-96">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Type</Th>
              <Th>Data</Th>
              <Th>Status</Th>
              <Th>Version</Th>
              <Th>Duration</Th>
              <Th>Seed</Th>
            </tr>
          </thead>
          <tbody>
            {d.runs.map((x) => (
              <tr key={x.id} title={x.error ?? undefined}>
                <Td className="text-xs whitespace-nowrap">{dateTime(x.createdAt)}</Td>
                <Td className="text-xs">{humanize(x.runType)}</Td>
                <Td>
                  <ProvenanceBadge provenance={x.provenance} />
                </Td>
                <Td>
                  <Badge tone={x.status === 'SUCCEEDED' ? 'green' : x.status === 'FAILED' ? 'red' : 'sky'}>{x.status}</Badge>
                </Td>
                <Td className="text-xs">{d.versions.find((v) => v.id === x.versionId)?.label ?? '—'}</Td>
                <Td className="num text-xs">{x.durationMs === null ? '—' : `${(x.durationMs / 1000).toFixed(1)} s`}</Td>
                <Td className="max-w-40 truncate font-mono text-[11px] text-muted">{x.seed}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function LogSection({ d }: { d: ExperimentDetail }) {
  const items = [
    ...d.audit.map((a) => ({ id: `a${a.id}`, ts: a.ts, kind: 'audit', label: a.action, text: `${a.actorType.toLowerCase()} ${a.actorId}${a.details && Object.keys(a.details).length ? ` · ${JSON.stringify(a.details).slice(0, 220)}` : ''}`, level: a.action.includes('ERROR') ? 'ERROR' : 'INFO' })),
    ...d.events.map((e) => ({ id: `e${e.id}`, ts: e.createdAt, kind: 'event', label: e.eventType, text: e.message, level: e.level })),
  ].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return (
    <Card title="Activity" subtitle="Audit log and system events for this experiment" bodyClassName="p-0">
      <Table className="max-h-96">
        <tbody>
          {items.slice(0, 120).map((i) => (
            <tr key={i.id}>
              <Td className="text-xs whitespace-nowrap text-muted">{dateTime(i.ts)}</Td>
              <Td>
                <Badge tone={i.level === 'ERROR' ? 'red' : i.level === 'WARN' ? 'amber' : i.kind === 'audit' ? 'gray' : 'sky'}>{i.label}</Badge>
              </Td>
              <Td className="text-xs break-all">{i.text}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

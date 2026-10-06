import type { ReactNode } from 'react';
import { MultiLineChart } from '@/components/charts';
import { Card, ConfidenceBadge, Empty, ExperimentLink, NoData, PageHeader, Pnl, ProvenanceBadge, RiskBadge, ScoreBar, StatusBadge, Table, Td, Th } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { days, humanize, num, pct, usd } from '@/lib/format';
import type { Compare, Experiment, Performance, SearchParams } from '@/lib/types';

export const metadata = { title: 'Compare' };

type Row = Compare[number];
const sm = (e: Row, type: string) => (e.runs[type]?.summary ?? null) as Record<string, unknown> | null;

export default async function ComparePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const raw = sp.ids;
  const ids = (Array.isArray(raw) ? raw : raw ? raw.split(',') : []).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const all = await apiGet<Experiment[]>('/v1/experiments', { sort: 'rank' });

  if (ids.length < 2) {
    return (
      <div className="space-y-4">
        <PageHeader title="Compare" subtitle="Put experiments side by side: scores, evidence, backtest or simulation results, robustness and paper performance." />
        <Card title="Choose 2–8 experiments">
          <form method="get" className="space-y-3">
            <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
              {all.map((e) => (
                <label key={e.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-surface-2">
                  <input type="checkbox" name="ids" value={e.id} defaultChecked={ids.includes(e.id)} />
                  <span className="truncate">{e.name}</span>
                  <StatusBadge status={e.status} />
                </label>
              ))}
            </div>
            <button type="submit" className="rounded-md border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-white">
              Compare
            </button>
          </form>
        </Card>
      </div>
    );
  }

  const [rows, perf] = await Promise.all([apiGet<Compare>('/v1/compare', { ids: ids.join(',') }), apiGet<Performance>('/v1/performance', { limit: 50 })]);
  const curves = perf.curves.filter((c) => ids.includes(c.id));
  const backtestSeries = curves.filter((c) => c.backtest.length > 1).map((c) => ({ name: `${c.name} (${c.backtestProvenance ?? 'backtest'})`, points: c.backtest }));
  const paperSeries = curves.filter((c) => c.paper.length > 1).map((c) => ({ name: `${c.name} (${c.paperProvenance ?? 'paper'})`, points: c.paper }));

  const line = (label: string, render: (e: Row) => ReactNode): [string, (e: Row) => ReactNode] => [label, render];
  const lines: Array<[string, (e: Row) => ReactNode]> = [
    line('Status', (e) => <StatusBadge status={e.status} />),
    line('Category', (e) => humanize(e.category)),
    line('Score', (e) => <ScoreBar value={e.score?.overall} small />),
    line('Confidence', (e) => <ConfidenceBadge confidence={e.score?.confidence} />),
    line('Evidence', (e) => <ProvenanceBadge provenance={e.evidence} />),
    line('Risk level', (e) => <RiskBadge level={e.riskLevel} />),
    line('Simulated profit', (e) => (e.keyResult ? <Pnl value={e.keyResult.profit} format={(v) => usd(v, { signed: true })} /> : <NoData />)),
    line('ROI', (e) => (e.keyResult?.roiPct !== null && e.keyResult?.roiPct !== undefined ? <Pnl value={e.keyResult.roiPct} format={(v) => pct(v, { signed: true })} /> : <NoData />)),
    line('Max drawdown', (e) => (e.keyResult?.maxDrawdownPct !== null && e.keyResult?.maxDrawdownPct !== undefined ? pct(e.keyResult.maxDrawdownPct) : <NoData />)),
    line('Sharpe', (e) => num(sm(e, 'BACKTEST')?.sharpe)),
    line('Trades', (e) => num(sm(e, 'BACKTEST')?.trades, 0)),
    line('Win rate', (e) => pct(sm(e, 'BACKTEST')?.winRate)),
    line('Out-of-sample return', (e) => pct((sm(e, 'BACKTEST')?.test as Record<string, unknown> | null)?.totalReturnPct)),
    line('Walk-forward folds profitable', (e) => (sm(e, 'WALK_FORWARD') ? `${String(sm(e, 'WALK_FORWARD')!.profitableFolds)} / ${String(sm(e, 'WALK_FORWARD')!.folds)}` : <NoData />)),
    line('P(loss) Monte Carlo', (e) => pct(sm(e, 'MONTE_CARLO')?.probLoss)),
    line('Cost break-even', (e) => (sm(e, 'SENSITIVITY') ? (sm(e, 'SENSITIVITY')!.costBreakEvenMultiplier === null ? 'beyond range' : `${num(sm(e, 'SENSITIVITY')!.costBreakEvenMultiplier)}×`) : <NoData />)),
    line('P(profitable, 24 m)', (e) => pct(sm(e, 'SIMULATION')?.probProfitableAtHorizon)),
    line('Cash need P50', (e) => usd((sm(e, 'SIMULATION')?.maxCashNeed as Record<string, unknown> | undefined)?.p50)),
    line('Probability of ruin', (e) => pct(sm(e, 'SIMULATION')?.probRuin)),
    line('Paper P&L', (e) => (e.paper ? <Pnl value={e.paper.pnl} format={(v) => usd(v, { signed: true })} /> : <NoData />)),
    line('Capital requirement', (e) => usd(e.capitalRequirement, { digits: 0 })),
    line('Automation / scalability', (e) => `${e.automationScore} / ${e.scalabilityScore}`),
    line('Time to revenue', (e) => days(e.expectedTimeToRevenueDays)),
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Compare" subtitle="Mixed evidence types are shown as they are — a DEMO backtest, an ESTIMATED business case and a PAPER record are not interchangeable." />
      {rows.length < 2 ? (
        <Empty title="Not enough experiments">Some of the selected experiments do not exist.</Empty>
      ) : (
        <Card bodyClassName="p-0">
          <Table>
            <thead>
              <tr>
                <Th />
                {rows.map((e) => (
                  <Th key={e.id} className="min-w-48 normal-case">
                    <ExperimentLink id={e.id} name={e.name} />
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map(([label, render]) => (
                <tr key={label}>
                  <Td className="text-xs whitespace-nowrap text-muted">{label}</Td>
                  {rows.map((e) => (
                    <Td key={e.id} className="num">
                      {render(e)}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Backtest equity (indexed to 100)" subtitle="Each curve is labelled with its data provenance">
          <MultiLineChart series={backtestSeries} />
        </Card>
        <Card title="Paper / simulated equity (indexed to 100)">
          <MultiLineChart series={paperSeries} />
        </Card>
      </div>
    </div>
  );
}

import { Bars, MultiLineChart } from '@/components/charts';
import { Card, Empty, NoData, Notice, PageHeader, Pnl, ScoreBar, Table, Td, Th } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { humanize, usd } from '@/lib/format';
import type { Performance } from '@/lib/types';

export const metadata = { title: 'Performance' };

export default async function PerformancePage() {
  const p = await apiGet<Performance>('/v1/performance', { limit: 20 });
  const realBacktests = p.curves.filter((c) => c.backtest.length > 1 && c.backtestProvenance === 'HISTORICAL').map((c) => ({ name: c.name, points: c.backtest }));
  const demoBacktests = p.curves.filter((c) => c.backtest.length > 1 && c.backtestProvenance === 'DEMO').map((c) => ({ name: `${c.name} (DEMO)`, points: c.backtest, dashed: true }));
  const paper = p.curves.filter((c) => c.paper.length > 1 && c.paperProvenance === 'PAPER').map((c) => ({ name: c.name, points: c.paper }));
  const simulated = p.curves.filter((c) => c.paper.length > 1 && c.paperProvenance === 'SIMULATED').map((c) => ({ name: c.name, points: c.paper }));

  return (
    <div className="space-y-4">
      <PageHeader title="Performance" subtitle="Equity curves indexed to 100 at the start, grouped by where the numbers come from. Mixed provenance is never merged into one chart." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Paper trading (PAPER)" subtitle="Virtual money on live market data">
          <MultiLineChart series={paper} />
        </Card>
        <Card title="Simulated business operations (SIMULATED)" subtitle="Virtual customers and costs from the business models">
          <MultiLineChart series={simulated} />
        </Card>
        <Card title="Backtests on historical data (HISTORICAL)">
          <MultiLineChart series={realBacktests} />
        </Card>
        <Card title="Backtests on DEMO data" subtitle="Synthetic data: proves the code runs, says nothing about an edge">
          {demoBacktests.length ? (
            <>
              <Notice tone="purple">These curves come from synthetic random walks. They are shown so you can check behaviour (trading frequency, cost drag) — never as performance.</Notice>
              <div className="mt-3">
                <MultiLineChart series={demoBacktests} />
              </div>
            </>
          ) : (
            <MultiLineChart series={[]} />
          )}
        </Card>
      </div>
      <Card title="By category" bodyClassName="p-0">
        {p.byCategory.length === 0 ? (
          <div className="p-4">
            <Empty title="No data" />
          </div>
        ) : (
          <div className="grid gap-4 p-4 xl:grid-cols-2">
            <Table>
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th>Experiments</Th>
                  <Th>Avg. score</Th>
                  <Th>Paper / simulated P&amp;L</Th>
                </tr>
              </thead>
              <tbody>
                {p.byCategory.map((c) => (
                  <tr key={c.category}>
                    <Td>{humanize(c.category)}</Td>
                    <Td className="num">{c.experiments}</Td>
                    <Td>{c.avgScore === null ? <NoData /> : <ScoreBar value={c.avgScore} small />}</Td>
                    <Td>
                      <Pnl value={c.paperPnl} format={(v) => usd(v, { signed: true })} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Bars rows={p.byCategory.filter((c) => c.avgScore !== null).map((c) => ({ label: humanize(c.category), value: c.avgScore ?? 0 }))} />
          </div>
        )}
      </Card>
    </div>
  );
}

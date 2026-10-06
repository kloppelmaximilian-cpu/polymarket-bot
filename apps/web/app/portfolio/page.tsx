import Link from 'next/link';
import { Card, Empty, ExperimentLink, Kpi, NoData, Notice, PageHeader, Pnl, ProvenanceBadge, StatusBadge, Table, Td, Th, Badge } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { ago, pct, usd } from '@/lib/format';
import type { Portfolio } from '@/lib/types';

export const metadata = { title: 'Paper portfolio' };

export default async function PortfolioPage() {
  const p = await apiGet<Portfolio>('/v1/portfolio');
  const active = p.accounts.filter((a) => a.status === 'ACTIVE' && !a.isDemo);
  const paper = active.filter((a) => a.provenance === 'PAPER');
  const sim = active.filter((a) => a.provenance === 'SIMULATED');
  const sum = (xs: typeof active, f: (a: (typeof active)[number]) => number) => (xs.length ? xs.reduce((s, a) => s + f(a), 0) : null);

  return (
    <div className="space-y-4">
      <PageHeader title="Paper portfolio" subtitle="Virtual accounts only. Every deposit, fill, fee, funding payment, revenue and cost is a ledger transaction that cannot be edited." />
      <Notice tone="blue" title="Two separate pools">
        PAPER accounts trade virtual money on live market data (fund {usd(p.fund.total, { digits: 0 })}, {usd(p.fund.allocated, { digits: 0 })} allocated). SIMULATED accounts run business models on virtual customers from a separate simulation budget ({usd(p.simulationBudget.total, { digits: 0 })}, {usd(p.simulationBudget.allocated, { digits: 0 })} allocated). Their results are never added together.
      </Notice>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Paper equity" value={sum(paper, (a) => a.equity) === null ? <NoData /> : usd(sum(paper, (a) => a.equity))} badge={<ProvenanceBadge provenance="PAPER" />} hint={`${paper.length} active account(s)`} />
        <Kpi label="Paper P&L" value={<Pnl value={sum(paper, (a) => a.pnl)} format={(v) => usd(v, { signed: true })} />} hint={`fees ${usd(sum(paper, (a) => a.fees) ?? 0)}`} />
        <Kpi label="Fund allocated" value={usd(p.fund.allocated, { digits: 0 })} hint={`${usd(p.fund.unallocated, { digits: 0 })} unallocated of ${usd(p.fund.total, { digits: 0 })}`} />
        <Kpi label="Simulated business P&L" value={<Pnl value={sum(sim, (a) => a.pnl)} format={(v) => usd(v, { signed: true })} />} badge={<ProvenanceBadge provenance="SIMULATED" />} hint={`${sim.length} simulated operation(s)`} />
      </div>
      <Card title="Accounts" bodyClassName="p-0">
        {p.accounts.length === 0 ? (
          <div className="p-4">
            <Empty title="No paper accounts yet">Accounts open when an experiment passes the pre-paper gate.</Empty>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Experiment</Th>
                <Th>Type</Th>
                <Th>Account</Th>
                <Th>Start</Th>
                <Th>Equity</Th>
                <Th>P&amp;L</Th>
                <Th>Realized</Th>
                <Th>Unrealized</Th>
                <Th>Fees</Th>
                <Th>Exposure</Th>
                <Th>Drawdown</Th>
                <Th>Pos. / orders</Th>
                <Th>Last tick</Th>
              </tr>
            </thead>
            <tbody>
              {p.accounts.map((a) => (
                <tr key={a.id} className={a.status === 'ACTIVE' ? '' : 'opacity-60'}>
                  <Td className="min-w-52">
                    <ExperimentLink id={a.experimentId} name={a.experimentName} />
                    <div className="mt-0.5">
                      <StatusBadge status={a.experimentStatus} />
                    </div>
                  </Td>
                  <Td>
                    <ProvenanceBadge provenance={a.isDemo ? 'DEMO' : a.provenance} />
                  </Td>
                  <Td>
                    <Link href={`/portfolio/${a.id}`} className="text-xs text-accent hover:underline">
                      ledger →
                    </Link>
                    <div>
                      <Badge tone={a.status === 'ACTIVE' ? 'green' : 'gray'}>{a.status}</Badge>
                    </div>
                  </Td>
                  <Td className="num text-xs">{usd(a.startingCapital, { digits: 0 })}</Td>
                  <Td className="num text-xs">{usd(a.equity)}</Td>
                  <Td className="text-xs">
                    <Pnl value={a.pnl} format={(v) => usd(v, { signed: true })} />
                  </Td>
                  <Td className="text-xs">
                    <Pnl value={a.realizedPnl} format={(v) => usd(v, { signed: true })} />
                  </Td>
                  <Td className="text-xs">{a.unrealizedPnl === null ? <NoData /> : <Pnl value={a.unrealizedPnl} format={(v) => usd(v, { signed: true })} />}</Td>
                  <Td className="num text-xs">{usd(a.fees)}</Td>
                  <Td className="num text-xs">{a.exposure === null ? <NoData /> : usd(a.exposure)}</Td>
                  <Td className="num text-xs">{a.drawdownPct === null ? <NoData /> : pct(a.drawdownPct)}</Td>
                  <Td className="num text-xs">
                    {a.openPositions} / {a.openOrders}
                  </Td>
                  <Td className="text-xs whitespace-nowrap text-muted">{ago(a.lastTickAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

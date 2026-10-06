import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DrawdownChart, EquityChart } from '@/components/charts';
import { Badge, Card, KeyValues, NoData, PageHeader, Pnl, ProvenanceBadge, Table, Td, Th, clsx } from '@/components/ui';
import { ApiError, apiGet } from '@/lib/api';
import { dateTime, num, usd } from '@/lib/format';
import type { AccountDetail } from '@/lib/types';

export const metadata = { title: 'Paper account' };

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let d: AccountDetail;
  try {
    d = await apiGet<AccountDetail>(`/v1/portfolio/accounts/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  const a = d.account;
  const curve = d.equityCurve.map((p) => ({ ts: new Date(p.ts).getTime(), value: Number(p.equity) }));
  return (
    <div className="space-y-4">
      <PageHeader
        title={a.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <ProvenanceBadge provenance={a.isDemo ? 'DEMO' : a.provenance} /> <Badge tone={a.status === 'ACTIVE' ? 'green' : 'gray'}>{a.status}</Badge>
            <Link href={`/experiments/${a.experimentId}`} className="text-accent hover:underline">
              experiment →
            </Link>
          </span>
        }
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Equity" className="xl:col-span-2">
          <EquityChart points={curve} baseline={Number(a.startingCapital)} />
          <DrawdownChart points={curve} height={110} />
        </Card>
        <Card title="Account">
          <KeyValues
            rows={[
              ['Starting capital', usd(a.startingCapital)],
              ['Cash', usd(a.cash)],
              ['Realized P&L', <Pnl key="r" value={a.realizedPnl} format={(v) => usd(v, { signed: true })} />],
              ['Fees paid', usd(a.feesPaid)],
              ['Slippage cost', usd(a.slippageCost)],
              ['Funding P&L', <Pnl key="f" value={a.fundingPnl} format={(v) => usd(v, { signed: true })} />],
              ['Operating P&L', <Pnl key="o" value={a.operatingPnl} format={(v) => usd(v, { signed: true })} />],
              ['Peak equity', usd(a.peakEquity)],
              ['Spend (total / API)', `${usd(a.spendTotal)} / ${usd(a.apiSpendTotal)}`],
              ['Ledger entries', num(a.ledgerSeq, 0)],
              ['Simulated days', num(a.simulatedDays, 0)],
              ['Opened', dateTime(a.createdAt)],
              ['Last tick', dateTime(a.lastTickAt)],
            ]}
          />
        </Card>
      </div>
      <Card title={`Positions (${d.positions.length})`} bodyClassName="p-0">
        <Table>
          <thead>
            <tr>
              <Th>Venue</Th>
              <Th>Symbol</Th>
              <Th>Kind</Th>
              <Th>Quantity</Th>
              <Th>Avg price</Th>
              <Th>Mark</Th>
              <Th>Realized</Th>
            </tr>
          </thead>
          <tbody>
            {d.positions.map((p) => (
              <tr key={p.id}>
                <Td className="text-xs">{p.venue}</Td>
                <Td className="text-xs">{p.symbol}</Td>
                <Td className="text-xs">{p.instrumentKind}</Td>
                <Td className="num text-xs">{num(p.quantity, 6)}</Td>
                <Td className="num text-xs">{num(p.avgPrice, 4)}</Td>
                <Td className="num text-xs">{p.markPrice === null ? <NoData /> : num(p.markPrice, 4)}</Td>
                <Td className="text-xs">
                  <Pnl value={p.realizedPnl} format={(v) => usd(v, { signed: true })} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`Fills (${d.fills.length})`} bodyClassName="p-0">
          <Table className="max-h-[32rem]">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Symbol</Th>
                <Th>Side</Th>
                <Th>Qty</Th>
                <Th>Price</Th>
                <Th>Fee</Th>
                <Th>Liquidity</Th>
              </tr>
            </thead>
            <tbody>
              {d.fills.map((f) => (
                <tr key={f.id}>
                  <Td className="text-xs whitespace-nowrap">{dateTime(f.ts)}</Td>
                  <Td className="text-xs">{f.symbol}</Td>
                  <Td className={clsx('text-xs font-semibold', f.side === 'BUY' ? 'text-positive' : 'text-negative')}>{f.side}</Td>
                  <Td className="num text-xs">{num(f.quantity, 6)}</Td>
                  <Td className="num text-xs">{num(f.price, 4)}</Td>
                  <Td className="num text-xs">{usd(f.fee, { digits: 4 })}</Td>
                  <Td className="text-xs">{f.liquidity}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title={`Ledger (${d.transactions.length} latest)`} subtitle="Append-only: enforced by a database trigger" bodyClassName="p-0">
          <Table className="max-h-[32rem]">
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Time</Th>
                <Th>Type</Th>
                <Th>Amount</Th>
                <Th>Balance</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody>
              {d.transactions.map((t) => (
                <tr key={t.id}>
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
                  <Td className="max-w-xs truncate text-xs text-muted" title={t.description ?? undefined}>
                    {t.description}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

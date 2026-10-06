import { Badge, Card, Empty, ExperimentLink, Kpi, Notice, PageHeader, RiskBadge, StatusBadge, Table, Td, Th, clsx } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { ago, dateTime, humanize, pct, usd } from '@/lib/format';
import type { LiveStatus, RiskOverview } from '@/lib/types';

export const metadata = { title: 'Risk' };

export default async function RiskPage() {
  const [r, live] = await Promise.all([apiGet<RiskOverview>('/v1/risk'), apiGet<LiveStatus>('/v1/live/status')]);
  const monitored = r.experiments.filter((e) => e.utilization);
  const open = r.events.filter((e) => !e.resolvedAt);
  return (
    <div className="space-y-4">
      <PageHeader title="Risk" subtitle="Central risk engine: limits per experiment (capital, daily loss, drawdown, exposure, positions, orders, API spend, experiment spend) checked before every paper order and on every tick." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Overall" value={humanize(r.overall)} tone={r.overall === 'NORMAL' ? 'positive' : r.overall === 'WARNING' ? 'warning' : 'negative'} />
        <Kpi label="Emergency stop" value={r.emergencyStop.engaged ? 'ENGAGED' : 'Released'} tone={r.emergencyStop.engaged ? 'negative' : 'positive'} hint={r.emergencyStop.engaged ? `${r.emergencyStop.reason} · ${ago(r.emergencyStop.engagedAt)}` : r.emergencyStop.releasedAt ? `last released ${ago(r.emergencyStop.releasedAt)}` : 'never engaged'} />
        <Kpi label="Monitored accounts" value={monitored.length} hint="experiments with an active paper account" />
        <Kpi label="Open risk events" value={open.length} tone={open.length ? 'warning' : 'muted'} />
      </div>

      <Card title="Live trading gate" subtitle="Live trading is not implemented. The gate lists everything that would be required — all layers must pass, and the last one never does in this build.">
        <ul className="space-y-1 text-[13px]">
          {live.reasons.map((x) => (
            <li key={x} className="flex items-start gap-2">
              <Badge tone="red">closed</Badge>
              <span>{x}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Limit utilisation" subtitle="≥ 80 % warns, ≥ 100 % breaches; a breach of a loss, drawdown or spend limit stops the experiment" bodyClassName="p-0">
        {monitored.length === 0 ? (
          <div className="p-4">
            <Empty title="No paper account yet" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Experiment</Th>
                <Th>Status</Th>
                <Th>Risk</Th>
                {['Capital', 'Daily loss', 'Drawdown', 'Exposure', 'Positions', 'Orders/day', 'API spend', 'Spend'].map((h) => (
                  <Th key={h}>{h}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monitored.map((e) => {
                const by = new Map(e.utilization!.map((l) => [l.limit, l]));
                return (
                  <tr key={e.experimentId}>
                    <Td className="min-w-48">
                      <ExperimentLink id={e.experimentId} name={e.name} />
                    </Td>
                    <Td>
                      <StatusBadge status={e.status} />
                    </Td>
                    <Td>
                      <RiskBadge level={e.riskLevel} />
                    </Td>
                    {(['maxCapital', 'maxDailyLoss', 'maxDrawdownPct', 'maxExposure', 'maxPositions', 'maxOrdersPerDay', 'maxApiSpend', 'maxExperimentSpend'] as const).map((k) => {
                      const l = by.get(k);
                      return (
                        <Td key={k} className="num text-xs" title={l?.message}>
                          {l ? <span className={clsx(l.severity === 'WARNING' && 'text-warning', (l.severity === 'BREACH' || l.severity === 'CRITICAL') && 'font-semibold text-negative')}>{pct(l.utilization, { digits: 0 })}</span> : '—'}
                        </Td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Risk events" bodyClassName="p-0">
        {r.events.length === 0 ? (
          <div className="p-4">
            <Empty title="No risk events" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Severity</Th>
                <Th>Experiment</Th>
                <Th>Limit</Th>
                <Th>Message</Th>
                <Th>Action</Th>
                <Th>Resolved</Th>
              </tr>
            </thead>
            <tbody>
              {r.events.map((e) => (
                <tr key={e.id}>
                  <Td className="text-xs whitespace-nowrap">{dateTime(e.createdAt)}</Td>
                  <Td>
                    <Badge tone={e.severity === 'WARNING' ? 'amber' : e.severity === 'INFO' ? 'gray' : 'red'}>{e.severity}</Badge>
                  </Td>
                  <Td className="text-xs">{e.experimentId && e.experimentName ? <ExperimentLink id={e.experimentId} name={e.experimentName} /> : 'system'}</Td>
                  <Td className="text-xs">{e.limitName}</Td>
                  <Td className="max-w-md text-xs">{e.message}</Td>
                  <Td className="text-xs">{humanize(e.action)}</Td>
                  <Td className="text-xs text-muted">{e.resolvedAt ? ago(e.resolvedAt) : 'open'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Notice tone="gray">
        Limits per experiment are edited on the experiment page. Default limits scale with the paper allocation (e.g. daily loss 5 %, drawdown 20 %, per-order notional 25 %); businesses stop when their simulated budget ({usd(5000, { digits: 0 })}+ cap) runs out.
      </Notice>
    </div>
  );
}

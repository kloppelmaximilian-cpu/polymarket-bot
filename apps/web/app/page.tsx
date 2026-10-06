import Link from 'next/link';
import { OpportunityTable } from '@/components/opportunity-table';
import { Badge, ButtonLink, Card, ConfidenceBadge, Empty, ExperimentLink, HealthDot, Kpi, NoData, Pnl, ProvenanceBadge, StatusBadge, Table, Td, Th } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { ago, humanize, score, usd } from '@/lib/format';
import type { Dashboard, SystemHealth } from '@/lib/types';

export const metadata = { title: 'Dashboard' };

const RISK_TONE = { NORMAL: 'positive', WARNING: 'warning', BREACH: 'negative', EMERGENCY_STOP: 'negative' } as const;

export default async function DashboardPage() {
  const [d, health] = await Promise.all([apiGet<Dashboard>('/v1/dashboard'), apiGet<SystemHealth>('/v1/system/health')]);
  const statusOrder = ['RESEARCHING', 'PROTOTYPE', 'BACKTESTING', 'EVALUATING', 'PAPER', 'PROBATION', 'PROMISING', 'READY_FOR_LIVE_REVIEW', 'PAUSED', 'FAILED', 'DISCOVERED'];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">Every automated idea, strategy and business model — researched, simulated, backtested and paper-tested. Mode: {d.mode}.</p>
        </div>
        <div className="flex gap-2">
          <ButtonLink href="/opportunities">All opportunities</ButtonLink>
          <ButtonLink href="/experiments#new" variant="primary">
            New experiment
          </ButtonLink>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Total experiments" value={d.totals.totalExperiments} hint={`${d.totals.failed} failed · archived excluded`} href="/experiments" />
        <Kpi label="Active experiments" value={d.totals.activeExperiments} hint="research → paper, not paused/failed" href="/experiments?status=RESEARCHING,PROTOTYPE,BACKTESTING,EVALUATING,PAPER,PROBATION,PROMISING,READY_FOR_LIVE_REVIEW" />
        <Kpi
          label="Paper portfolio"
          value={d.paperPortfolio.equity === null ? <NoData /> : usd(d.paperPortfolio.equity)}
          hint={`${d.paperPortfolio.activeAccounts} account(s) · ${usd(d.paperPortfolio.allocated, { digits: 0 })} of the ${usd(d.paperPortfolio.fund, { digits: 0 })} fund allocated`}
          badge={<ProvenanceBadge provenance="PAPER" />}
          href="/portfolio"
        />
        <Kpi
          label="Total simulated profit"
          value={
            <span className="flex flex-col gap-1 text-base">
              <span className="flex items-center gap-2">
                <Pnl value={d.totalSimulatedProfit.paper} format={(v) => usd(v, { signed: true })} /> <ProvenanceBadge provenance="PAPER" />
              </span>
              <span className="flex items-center gap-2">
                <Pnl value={d.totalSimulatedProfit.simulatedOperations} format={(v) => usd(v, { signed: true })} /> <ProvenanceBadge provenance="SIMULATED" />
              </span>
            </span>
          }
          hint="Reported separately, never added. DEMO excluded."
          href="/performance"
        />
        <Kpi
          label="Total capital simulated"
          value={d.totalCapitalSimulated === null ? <NoData /> : usd(d.totalCapitalSimulated, { digits: 0 })}
          hint={`virtual: ${usd(d.paperPortfolio.allocated, { digits: 0 })} paper + ${usd(d.simulationBudget.allocated, { digits: 0 })} business simulation budgets`}
          href="/portfolio"
        />
        <Kpi
          label="Best strategy"
          value={d.bestStrategy ? <span className="text-base">{d.bestStrategy.name}</span> : <NoData />}
          hint={d.bestStrategy ? <span className="flex items-center gap-1.5">score {score(d.bestStrategy.score)} <ProvenanceBadge provenance={d.bestStrategy.evidence} /> <ConfidenceBadge confidence={d.bestStrategy.confidence} /></span> : 'no scored trading strategy yet'}
          href={d.bestStrategy ? `/experiments/${d.bestStrategy.id}` : undefined}
        />
        <Kpi
          label="Best business model"
          value={d.bestBusinessModel ? <span className="text-base">{d.bestBusinessModel.name}</span> : <NoData />}
          hint={d.bestBusinessModel ? <span className="flex items-center gap-1.5">score {score(d.bestBusinessModel.score)} <ProvenanceBadge provenance={d.bestBusinessModel.evidence} /> <ConfidenceBadge confidence={d.bestBusinessModel.confidence} /></span> : 'no scored business model yet'}
          href={d.bestBusinessModel ? `/experiments/${d.bestBusinessModel.id}` : undefined}
        />
        <Kpi label="Average score" value={d.averageScore === null ? <NoData /> : score(d.averageScore)} hint="0–100, evidence-capped" href="/opportunities" />
        <Kpi
          label="Risk status"
          value={humanize(d.riskStatus.status)}
          tone={RISK_TONE[d.riskStatus.status]}
          hint={`${d.riskStatus.openEvents24h} open risk event(s) in 24 h`}
          href="/risk"
        />
        <Kpi
          label="System"
          value={<HealthDot status={health.components[0]?.status ?? 'UNKNOWN'} label={humanize(health.components[0]?.status ?? 'unknown')} />}
          hint={health.components
            .slice(1)
            .filter((c) => c.status !== 'ONLINE')
            .map((c) => `${c.component}: ${c.status.toLowerCase()}`)
            .join(' · ') || 'all components online'}
          href="/system"
        />
      </div>

      <Card title="Top opportunities" subtitle="Ranked by Opportunity Score. Unverified estimates and DEMO data are capped and marked with low confidence." actions={<ButtonLink href="/opportunities">Filter & compare</ButtonLink>} bodyClassName="p-0">
        <OpportunityTable rows={d.topOpportunities} emptyHint="Nothing is scored yet. The worker runs research → backtest → evaluation automatically; scores appear after the first evaluation." />
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Pipeline" subtitle="Experiments by status">
          <div className="space-y-1.5">
            {statusOrder
              .filter((s) => d.totals.byStatus[s])
              .map((s) => (
                <Link key={s} href={`/experiments?status=${s}`} className="flex items-center justify-between rounded px-1 py-0.5 hover:bg-surface-2">
                  <StatusBadge status={s} />
                  <span className="num text-sm font-semibold">{d.totals.byStatus[s]}</span>
                </Link>
              ))}
            {Object.keys(d.totals.byStatus).length === 0 ? <Empty title="No experiments">Run `pnpm db:seed` to create the starter experiments.</Empty> : null}
          </div>
        </Card>
        <Card title="Next to review" subtitle="Needs a human decision">
          {d.nextToReview.length === 0 ? (
            <Empty title="Nothing waiting" />
          ) : (
            <ul className="space-y-2">
              {d.nextToReview.map((e) => (
                <li key={e.id} className="text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <ExperimentLink id={e.id} name={e.name} />
                    <StatusBadge status={e.status} />
                  </div>
                  {e.reason ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{e.reason}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recently improved" subtitle="New versions (never overwritten)">
          {d.recentlyImproved.length === 0 ? (
            <Empty title="No new versions yet">The Strategy Lab proposes CANDIDATE versions; you promote them.</Empty>
          ) : (
            <ul className="space-y-2 text-[13px]">
              {d.recentlyImproved.map((v) => (
                <li key={v.id}>
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/experiments/${v.experimentId}#versions`} className="font-medium hover:text-accent">
                      {v.label}
                    </Link>
                    <Badge tone={v.status === 'ACTIVE' ? 'green' : v.status === 'CANDIDATE' ? 'sky' : 'gray'}>{v.status}</Badge>
                  </div>
                  <p className="text-xs text-muted">
                    {v.changeNote} · {ago(v.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="New ideas" actions={<ButtonLink href="/research">Research & ideas</ButtonLink>} bodyClassName="p-0">
          {d.recentIdeas.length === 0 ? (
            <div className="p-4">
              <Empty title="No ideas yet" />
            </div>
          ) : (
            <Table>
              <tbody>
                {d.recentIdeas.map((i) => (
                  <tr key={i.id}>
                    <Td className="font-medium">{i.name}</Td>
                    <Td className="text-xs text-muted">{humanize(i.category)}</Td>
                    <Td>
                      <Badge tone="gray">{i.origin}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={i.status === 'CONVERTED' ? 'green' : i.status === 'REJECTED' ? 'red' : 'sky'}>{i.status}</Badge>
                    </Td>
                    <Td className="text-xs whitespace-nowrap text-muted">{ago(i.createdAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Recent activity" subtitle="From the append-only audit log" actions={<ButtonLink href="/logs">All logs</ButtonLink>} bodyClassName="p-0">
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Entity</Th>
              </tr>
            </thead>
            <tbody>
              {d.recentActivity.map((a) => (
                <tr key={a.id}>
                  <Td className="text-xs whitespace-nowrap text-muted">{ago(a.ts)}</Td>
                  <Td className="text-xs">{a.actorType.toLowerCase()}</Td>
                  <Td>
                    <Badge tone={a.action.includes('EMERGENCY') || a.action.includes('ERROR') ? 'red' : 'gray'}>{a.action}</Badge>
                  </Td>
                  <Td className="text-xs text-muted">{a.experimentId ? <Link href={`/experiments/${a.experimentId}`}>{a.entityType}</Link> : a.entityType}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton, ActionForm, Submit } from '@/components/forms';
import { Badge, Card, Empty, KeyValues, Notice, ProvenanceBadge, RiskBadge, StatusBadge } from '@/components/ui';
import { experimentAction, flattenPositions, queueLab } from '@/lib/actions';
import { ApiError, apiGet } from '@/lib/api';
import { ago, dateTime, days, humanize, usd } from '@/lib/format';
import type { ExperimentDetail, Versions } from '@/lib/types';
import { AssumptionsSection, BacktestSection, ComplianceSection, GatesSection, LogSection, PaperSection, RiskSection, RobustnessSection, RunsSection, ScoreSection, SimulationSection, VersionsSection } from './sections';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const d = await apiGet<ExperimentDetail>(`/v1/experiments/${encodeURIComponent(id)}`);
    return { title: d.experiment.name };
  } catch {
    return { title: 'Experiment' };
  }
}

const PAUSABLE = ['RESEARCHING', 'PROTOTYPE', 'BACKTESTING', 'EVALUATING', 'PAPER', 'PROBATION', 'PROMISING', 'READY_FOR_LIVE_REVIEW'];

export default async function ExperimentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let d: ExperimentDetail;
  try {
    d = await apiGet<ExperimentDetail>(`/v1/experiments/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const versions = await apiGet<Versions>(`/v1/experiments/${d.experiment.id}/versions`);
  const e = d.experiment;
  const isBusiness = e.kind === 'BUSINESS';
  const evidence = d.latestRuns.BACKTEST?.provenance ?? d.latestRuns.SIMULATION?.provenance ?? null;
  const hidden = { id: e.id };
  const paper = d.paper as { positions?: unknown[] } | null;
  const idea = d.idea;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-muted">
            <Link href="/experiments" className="hover:text-text">
              Experiments
            </Link>{' '}
            / {humanize(e.category)}
          </div>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {e.name} <StatusBadge status={e.status} /> {evidence ? <ProvenanceBadge provenance={evidence} /> : null} {e.isDemo ? <Badge tone="purple">DEMO</Badge> : null}
          </h1>
          <p className="mt-1 max-w-4xl text-sm text-muted">{e.statusReason ?? '—'}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {e.status === 'DISCOVERED' ? (
            <ActionButton action={experimentAction} hidden={{ ...hidden, action: 'start' }} variant="primary">
              Start research
            </ActionButton>
          ) : null}
          {PAUSABLE.includes(e.status) ? (
            <ActionButton action={experimentAction} hidden={{ ...hidden, action: 'advance' }}>
              Run next step now
            </ActionButton>
          ) : null}
          {PAUSABLE.includes(e.status) ? (
            <ActionButton action={experimentAction} hidden={{ ...hidden, action: 'pause' }}>
              Pause
            </ActionButton>
          ) : null}
          {e.status === 'PAUSED' ? (
            <ActionButton action={experimentAction} hidden={{ ...hidden, action: 'resume' }} variant="primary">
              Resume
            </ActionButton>
          ) : null}
          {e.status === 'FAILED' || e.status === 'ARCHIVED' ? (
            <ActionButton action={experimentAction} hidden={{ ...hidden, action: 'revive' }} confirm="Revive this experiment? It goes back to RESEARCHING and must pass every gate again.">
              Revive
            </ActionButton>
          ) : null}
          {!isBusiness && e.status !== 'ARCHIVED' ? (
            <ActionButton action={queueLab} hidden={hidden}>
              Strategy Lab
            </ActionButton>
          ) : null}
          {e.status !== 'ARCHIVED' ? (
            <ActionButton action={experimentAction} hidden={{ ...hidden, action: 'archive' }} confirm="Archive this experiment? It stops and disappears from rankings (it can be revived).">
              Archive
            </ActionButton>
          ) : null}
        </div>
      </div>

      {e.status === 'READY_FOR_LIVE_REVIEW' ? (
        <Notice tone="green" title="Ready for a manual live review — live trading remains disabled">
          This experiment passed every automated gate on paper. That is a reason for a human to look closely, not permission to trade: this build has no live executor, and live trading would additionally require an environment flag, an explicit live flag, a capital cap, a confirmation phrase, an approval and an audit trail.
        </Notice>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Overview" className="xl:col-span-2">
          <p className="text-sm">{e.description}</p>
          {e.hypothesis ? (
            <p className="mt-2 text-sm text-muted">
              <strong className="text-text">Hypothesis:</strong> {e.hypothesis}
            </p>
          ) : null}
          <KeyValues
            className="mt-4 md:grid-cols-[minmax(8rem,auto)_1fr_minmax(8rem,auto)_1fr]"
            rows={[
              ['Module', <span key="m" className="font-mono text-xs">{e.strategyId}{d.strategy ? ` @ ${d.strategy.moduleVersion}` : ''}</span>],
              ['Kind', humanize(e.kind)],
              ['Risk level', <RiskBadge key="r" level={e.riskLevel} />],
              ['Version', d.currentVersion?.label ?? '—'],
              ['Capital requirement', usd(e.capitalRequirement, { digits: 0 })],
              ['Paper capital', usd(e.paperCapital, { digits: 0 })],
              ['Automation / scalability / complexity', `${e.automationScore} / ${e.scalabilityScore} / ${e.complexityScore}`],
              ['Time to revenue', days(e.expectedTimeToRevenueDays)],
              ['Required data', (e.requiredData ?? []).join(', ') || '—'],
              ['Seed', <span key="s" className="font-mono text-xs">{e.seed}</span>],
              ['Created', dateTime(e.createdAt)],
              ['Last activity', ago(e.lastActivityAt)],
              ['Paper since', e.paperStartedAt ? dateTime(e.paperStartedAt) : '—'],
              ['Origin', idea ? `idea "${idea.name}" (${idea.origin.toLowerCase()})` : 'starter / manual'],
            ]}
          />
        </Card>
        <Card title="Research sources" subtitle="Where the idea and its assumptions come from">
          {d.sources.length === 0 ? (
            <Empty title="No sources linked">Add one on the Research page.</Empty>
          ) : (
            <ul className="space-y-2 text-[13px]">
              {d.sources.map((s) => (
                <li key={s.id}>
                  <a href={s.url} target="_blank" rel="noreferrer noopener" className="font-medium text-accent hover:underline">
                    {s.title}
                  </a>
                  <div className="text-xs text-muted">
                    {humanize(s.sourceType)}
                    {s.license ? ` · license ${s.license}` : ''}
                    {s.termsConcerns ? ` · ⚠ ${s.termsConcerns}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">{isBusiness ? <SimulationSection d={d} /> : <BacktestSection d={d} />}</div>
        <ScoreSection d={d} />
      </div>

      {isBusiness ? <AssumptionsSection d={d} /> : <RobustnessSection d={d} />}
      <GatesSection d={d} />
      <PaperSection d={d} />
      {paper?.positions?.length ? (
        <Card title="Manual flatten" subtitle="Close every open paper position at its last mark (risk-reducing only; allowed even when limits are breached)">
          <ActionForm action={flattenPositions} hidden={hidden} className="flex flex-wrap items-end gap-2">
            <input name="reason" required minLength={3} placeholder="reason" aria-label="Reason" />
            <Submit variant="danger" confirm="Close all paper positions of this experiment?">
              Flatten positions
            </Submit>
          </ActionForm>
        </Card>
      ) : null}
      <VersionsSection d={d} versions={versions} />
      <div className="grid gap-4 xl:grid-cols-2">
        <RiskSection d={d} />
        <ComplianceSection d={d} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <RunsSection d={d} />
        <LogSection d={d} />
      </div>
    </div>
  );
}

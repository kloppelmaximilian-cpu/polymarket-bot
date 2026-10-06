import { ExperimentFilters, readFilters } from '@/components/filters';
import { ActionForm, Field, Submit } from '@/components/forms';
import { Card, Empty, ExperimentLink, NoData, PageHeader, Pnl, ProvenanceBadge, RiskBadge, ScoreBar, StatusBadge, Table, Td, Th } from '@/components/ui';
import { createExperiment } from '@/lib/actions';
import { apiGet } from '@/lib/api';
import { ago, humanize, usd } from '@/lib/format';
import type { Experiment, SearchParams, Strategies } from '@/lib/types';

export const metadata = { title: 'Experiments' };

export default async function ExperimentsPage({ searchParams }: { searchParams: SearchParams }) {
  const f = readFilters(await searchParams);
  const [rows, strategies] = await Promise.all([apiGet<Experiment[]>('/v1/experiments', { ...f, sort: f.sort ?? 'activity' }), apiGet<Strategies>('/v1/strategies')]);
  return (
    <div className="space-y-4">
      <PageHeader title="Experiments" subtitle="Each experiment is one idea under test: a strategy or business module, versioned parameters and assumptions, its runs, paper account, risk limits and compliance review." />
      <ExperimentFilters values={f} action="/experiments" />
      <Card title={`${rows.length} experiment(s)`} bodyClassName="p-0">
        {rows.length === 0 ? (
          <div className="p-4">
            <Empty title="No data">No experiment matches these filters.</Empty>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th>Status</Th>
                <Th>Why</Th>
                <Th>Score</Th>
                <Th>Evidence</Th>
                <Th>Paper P&amp;L</Th>
                <Th>Risk</Th>
                <Th>Activity</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="hover:bg-surface-2/60">
                  <Td className="min-w-56">
                    <ExperimentLink id={e.id} name={e.name} />
                    <div className="text-[11px] text-muted">
                      {humanize(e.category)} · <span className="font-mono">{e.strategyId}</span>
                    </div>
                  </Td>
                  <Td className="text-xs text-muted">{humanize(e.kind)}</Td>
                  <Td>
                    <StatusBadge status={e.status} />
                  </Td>
                  <Td className="max-w-md text-xs text-muted">
                    <span className="line-clamp-2">{e.statusReason ?? '—'}</span>
                    {e.failureReasons.length ? <span className="mt-0.5 block text-negative">{e.failureReasons.join(', ')}</span> : null}
                  </Td>
                  <Td>
                    <ScoreBar value={e.score?.overall} small />
                  </Td>
                  <Td>{e.evidence ? <ProvenanceBadge provenance={e.evidence} /> : <NoData />}</Td>
                  <Td className="whitespace-nowrap">{e.paper ? <Pnl value={e.paper.pnl} format={(v) => usd(v, { signed: true })} /> : <NoData />}</Td>
                  <Td>
                    <RiskBadge level={e.riskLevel} />
                  </Td>
                  <Td className="text-xs whitespace-nowrap text-muted">{ago(e.lastActivityAt ?? e.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="New experiment" subtitle="Creates an experiment in DISCOVERED (or starts research right away). Capital is virtual paper money from the paper fund." className="scroll-mt-20" bodyClassName="p-4">
        <div id="new" />
        <ActionForm action={createExperiment} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Strategy / business module">
            <select name="strategyId" required>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name (optional)">
            <input name="name" minLength={3} maxLength={200} placeholder="defaults to the module name" />
          </Field>
          <Field label="Paper capital, USD (optional)" hint="Business budgets are sized from their own estimate.">
            <input name="capital" type="number" min={1} max={1000000} step="any" placeholder="1000" />
          </Field>
          <Field label="Description (optional)">
            <input name="description" maxLength={5000} />
          </Field>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="startResearch" defaultChecked /> Start research now
          </label>
          <div className="flex items-end">
            <Submit variant="primary">Create experiment</Submit>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}

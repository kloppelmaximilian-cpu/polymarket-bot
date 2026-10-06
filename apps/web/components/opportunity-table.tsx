import { ago, days, humanize, pct, usd } from '@/lib/format';
import type { Experiment } from '@/lib/types';
import { ConfidenceBadge, Empty, ExperimentLink, NoData, Pnl, ProvenanceBadge, RiskBadge, ScoreBar, StatusBadge, Table, Td, Th } from './ui';

/**
 * The ranked opportunity table. Every money figure carries its provenance;
 * a missing figure is NO DATA, never zero.
 */
export function OpportunityTable({ rows, compareForm = false, emptyHint }: { rows: Experiment[]; compareForm?: boolean; emptyHint?: string }) {
  if (rows.length === 0) return <Empty title="No data">{emptyHint ?? 'No experiment matches. Start one from Experiments or let the pipeline run.'}</Empty>;
  const table = (
    <Table>
      <thead>
        <tr>
          {compareForm ? <Th className="w-8" title="Select to compare" /> : null}
          <Th>Rank</Th>
          <Th>Name</Th>
          <Th>Category</Th>
          <Th>Status</Th>
          <Th>Score</Th>
          <Th title="Backtest net profit (HISTORICAL/DEMO) or median 24-month profit of the business estimate (ESTIMATED)">Simulated profit</Th>
          <Th title="Virtual money on live data (PAPER) or simulated business operation (SIMULATED)">Paper profit</Th>
          <Th>ROI</Th>
          <Th>Max DD</Th>
          <Th>Risk</Th>
          <Th>Auto.</Th>
          <Th>Scale</Th>
          <Th>Capital req.</Th>
          <Th>Time to rev.</Th>
          <Th>Confidence</Th>
          <Th>Updated</Th>
          <Th>Next action</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => {
          const k = e.keyResult;
          return (
            <tr key={e.id} className="hover:bg-surface-2/60">
              {compareForm ? (
                <Td>
                  <input type="checkbox" name="ids" value={e.id} aria-label={`Compare ${e.name}`} className="size-3.5" />
                </Td>
              ) : null}
              <Td className="num text-muted">{e.score?.rank ? `#${e.score.rank}` : '—'}</Td>
              <Td className="min-w-52">
                <ExperimentLink id={e.id} name={e.name} />
                <div className="mt-0.5 font-mono text-[11px] text-muted">{e.strategyId}</div>
              </Td>
              <Td className="text-xs whitespace-nowrap text-muted">{humanize(e.category)}</Td>
              <Td>
                <StatusBadge status={e.status} />
              </Td>
              <Td>
                <ScoreBar value={e.score?.overall} small />
              </Td>
              <Td className="whitespace-nowrap">
                {k ? (
                  <span className="flex flex-col gap-0.5">
                    <Pnl value={k.profit} format={(v) => usd(v, { signed: true })} />
                    <span className="flex items-center gap-1">
                      <ProvenanceBadge provenance={k.provenance} />
                    </span>
                  </span>
                ) : (
                  <NoData />
                )}
              </Td>
              <Td className="whitespace-nowrap">
                {e.paper ? (
                  <span className="flex flex-col gap-0.5">
                    <Pnl value={e.paper.pnl} format={(v) => usd(v, { signed: true })} />
                    <ProvenanceBadge provenance={e.paper.isDemo ? 'DEMO' : e.paper.provenance} />
                  </span>
                ) : (
                  <NoData />
                )}
              </Td>
              <Td className="num whitespace-nowrap">{k?.roiPct !== null && k?.roiPct !== undefined ? <Pnl value={k.roiPct} format={(v) => pct(v, { signed: true })} /> : <NoData />}</Td>
              <Td className="num whitespace-nowrap">{k?.maxDrawdownPct !== null && k?.maxDrawdownPct !== undefined ? pct(k.maxDrawdownPct) : k?.probRuin !== null && k?.probRuin !== undefined ? <span title="Probability of running out of money (business estimate)">ruin {pct(k.probRuin, { digits: 0 })}</span> : <NoData />}</Td>
              <Td>
                <RiskBadge level={e.riskLevel} />
              </Td>
              <Td className="num">{e.automationScore}</Td>
              <Td className="num">{e.scalabilityScore}</Td>
              <Td className="num whitespace-nowrap">{usd(e.capitalRequirement, { digits: 0 })}</Td>
              <Td className="num whitespace-nowrap">{days(e.expectedTimeToRevenueDays)}</Td>
              <Td>
                <ConfidenceBadge confidence={e.score?.confidence} />
              </Td>
              <Td className="text-xs whitespace-nowrap text-muted">{ago(e.lastActivityAt ?? e.createdAt)}</Td>
              <Td className="min-w-48 text-xs text-muted">{e.nextAction}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
  if (!compareForm) return table;
  return (
    <form action="/compare" method="get">
      {table}
      <div className="mt-3 flex items-center gap-2">
        <button type="submit" className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[13px] font-medium hover:bg-surface-3">
          Compare selected
        </button>
        <span className="text-xs text-muted">Select 2–8 rows.</span>
      </div>
    </form>
  );
}

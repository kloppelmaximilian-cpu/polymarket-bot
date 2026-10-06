import { ExperimentFilters, readFilters } from '@/components/filters';
import { OpportunityTable } from '@/components/opportunity-table';
import { Card, Notice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { Experiment, SearchParams } from '@/lib/types';

export const metadata = { title: 'Opportunities' };

export default async function OpportunitiesPage({ searchParams }: { searchParams: SearchParams }) {
  const f = readFilters(await searchParams);
  const rows = await apiGet<Experiment[]>('/v1/experiments', { ...f });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Opportunities"
        subtitle="Every experiment ranked by its Opportunity Score (0–100). High profit with extreme risk does not rank higher automatically: risk multiplies the score and evidence caps it."
      />
      <ExperimentFilters values={f} action="/opportunities" />
      <Notice tone="amber" title="How to read this table">
        Simulated profit is a backtest (HISTORICAL or DEMO data) or a business estimate (ESTIMATED from unverified assumptions). Paper profit is virtual money on live data (PAPER) or a simulated business operation (SIMULATED). None of these is a forecast or a guarantee.
      </Notice>
      <Card title={`${rows.length} result(s)`} bodyClassName="p-0">
        <OpportunityTable rows={rows} compareForm />
      </Card>
    </div>
  );
}

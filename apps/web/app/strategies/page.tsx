import { Badge, Card, PageHeader, Table, Td, Th } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { humanize } from '@/lib/format';
import type { Strategies } from '@/lib/types';

export const metadata = { title: 'Strategies' };

export default async function StrategiesPage() {
  const rows = await apiGet<Strategies>('/v1/strategies');
  const groups = ['TRADING', 'PREDICTION_MARKET', 'ARBITRAGE', 'BUSINESS'].map((k) => [k, rows.filter((r) => r.kind === k)] as const).filter(([, list]) => list.length > 0);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Strategies & business models"
        subtitle="The modules experiments are built from. Each implements a common interface (trading: initialize → analyze → signal → size → risk check → paper order → manage → record; business: market → demand → costs → acquisition → conversion → revenue → profit → churn → evaluate). Our own implementations — no copied code."
      />
      {groups.map(([kind, list]) => (
        <Card key={kind} title={humanize(kind)} subtitle={`${list.length} module(s)`} bodyClassName="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Module</Th>
                <Th>Description</Th>
                <Th>Data</Th>
                <Th>Capabilities</Th>
                <Th>Default parameters</Th>
                <Th>Experiments</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <Td className="min-w-56">
                    <div className="font-medium">{s.name}</div>
                    <div className="font-mono text-[11px] text-muted">
                      {s.id} @ {s.moduleVersion}
                    </div>
                    <div className="mt-1 text-[11px] text-muted">{humanize(s.category)}</div>
                  </Td>
                  <Td className="max-w-lg text-xs text-muted">{s.description}</Td>
                  <Td className="text-xs">{(s.requiredData ?? []).join(', ') || '—'}</Td>
                  <Td>
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {Object.entries(s.capabilities ?? {})
                        .filter(([, v]) => v)
                        .map(([k]) => (
                          <Badge key={k} tone={k === 'requiresRealData' ? 'amber' : 'gray'}>
                            {k === 'requiresRealData' ? 'needs real data' : k}
                          </Badge>
                        ))}
                    </div>
                  </Td>
                  <Td className="max-w-xs">
                    <code className="block font-mono text-[11px] break-all text-muted">{JSON.stringify(s.defaultParams)}</code>
                  </Td>
                  <Td className="num text-xs whitespace-nowrap">
                    {s.experiments} total · {s.activeExperiments} active
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
    </div>
  );
}

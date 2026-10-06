import { ActionButton, ActionForm, Submit } from '@/components/forms';
import { Badge, Card, Empty, HealthDot, PageHeader, Table, Td, Th } from '@/components/ui';
import { markAllNotificationsRead, probeDataSources, queueJob } from '@/lib/actions';
import { apiGet } from '@/lib/api';
import { JOB_NAMES } from '@/lib/constants';
import { ago, dateTime, num } from '@/lib/format';
import type { DataSources, Jobs, Notifications, SystemHealth } from '@/lib/types';

export const metadata = { title: 'System' };

export default async function SystemPage() {
  const [health, sources, jobs, notifications] = await Promise.all([apiGet<SystemHealth>('/v1/system/health'), apiGet<DataSources>('/v1/data-sources'), apiGet<Jobs>('/v1/jobs'), apiGet<Notifications>('/v1/notifications')]);
  return (
    <div className="space-y-4">
      <PageHeader title="System" subtitle="Observability: each component is ONLINE, DEGRADED or OFFLINE with the reason; each data source is CONNECTED, STALE, DEGRADED or OFFLINE." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {health.components.map((c) => (
          <div key={c.component} className="rounded-lg border border-border bg-surface p-3">
            <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">{c.component}</div>
            <div className="mt-1.5 text-sm font-semibold">
              <HealthDot status={c.status} label={c.status} />
            </div>
            <div className="mt-1 text-[11px] text-muted">{c.detail}</div>
          </div>
        ))}
      </div>

      <Card title="Data sources" subtitle="Public endpoints only; rate limits respected; stale data is detected and never traded on." actions={<ActionButton action={probeDataSources}>Probe now</ActionButton>} bodyClassName="p-0">
        <Table>
          <thead>
            <tr>
              <Th>Source</Th>
              <Th>Kind</Th>
              <Th>Transport</Th>
              <Th>Status</Th>
              <Th>Last success</Th>
              <Th>Latency</Th>
              <Th>OK / errors</Th>
              <Th>Last error</Th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <Td>
                  <div className="text-[13px] font-medium">{s.name}</div>
                  <div className="font-mono text-[11px] text-muted">{s.id}</div>
                </Td>
                <Td className="text-xs">{s.kind}</Td>
                <Td className="text-xs">{s.transport}</Td>
                <Td className="text-xs">{s.enabled ? <HealthDot status={s.status} /> : <Badge tone="gray">disabled</Badge>}</Td>
                <Td className="text-xs whitespace-nowrap text-muted">{ago(s.lastSuccessAt)}</Td>
                <Td className="num text-xs">{s.latencyMs === null ? '—' : `${s.latencyMs} ms`}</Td>
                <Td className="num text-xs">
                  {num(s.successCount, 0)} / {num(s.errorCount, 0)}
                </Td>
                <Td className="max-w-sm truncate text-xs text-muted" title={s.lastError ?? undefined}>
                  {s.lastError ?? '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Workers" subtitle="Heartbeat every 10 s">
          {jobs.workers.length === 0 ? (
            <Empty title="No worker">Start it with pnpm dev (or pnpm dev:embedded).</Empty>
          ) : (
            <ul className="space-y-2 text-[13px]">
              {jobs.workers.map((w) => (
                <li key={w.workerId}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{w.workerId}</span>
                    <Badge tone={w.status === 'RUNNING' ? 'green' : 'gray'}>{w.status}</Badge>
                  </div>
                  <div className="text-xs text-muted">
                    seen {ago(w.lastSeenAt)} · pid {w.pid} · {w.jobsProcessed} processed · {w.jobsFailed} failed{w.currentJob ? ` · running ${w.currentJob}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={queueJob} className="mt-4 flex flex-wrap items-end gap-2">
            <select name="name" aria-label="Job">
              {JOB_NAMES.map((j) => (
                <option key={j} value={j}>
                  {j}
                </option>
              ))}
            </select>
            <Submit>Queue job</Submit>
          </ActionForm>
        </Card>
        <Card title="Recent jobs" className="xl:col-span-2" bodyClassName="p-0">
          <Table className="max-h-[28rem]">
            <thead>
              <tr>
                <Th>Created</Th>
                <Th>Job</Th>
                <Th>Status</Th>
                <Th>Attempts</Th>
                <Th>Result / error</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.jobs.slice(0, 80).map((j) => (
                <tr key={j.id}>
                  <Td className="text-xs whitespace-nowrap">{dateTime(j.createdAt)}</Td>
                  <Td className="font-mono text-xs">{j.name}</Td>
                  <Td>
                    <Badge tone={j.status === 'SUCCEEDED' ? 'green' : j.status === 'RUNNING' ? 'sky' : j.status === 'QUEUED' ? 'gray' : 'red'}>{j.status}</Badge>
                  </Td>
                  <Td className="num text-xs">
                    {j.attempts}/{j.maxAttempts}
                  </Td>
                  <Td className="max-w-md truncate text-[11px] text-muted" title={j.lastError ?? JSON.stringify(j.result)}>
                    {j.lastError ?? (j.result ? JSON.stringify(j.result).slice(0, 160) : '—')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <Card title="Notifications" subtitle="New experiment, finished experiment, new idea, improvement, risk event, error, emergency stop" actions={<ActionButton action={markAllNotificationsRead}>Mark all read</ActionButton>} bodyClassName="p-0">
        <div id="notifications" />
        {notifications.length === 0 ? (
          <div className="p-4">
            <Empty title="No notifications" />
          </div>
        ) : (
          <Table>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.id} className={n.readAt ? 'opacity-60' : ''}>
                  <Td className="text-xs whitespace-nowrap">{dateTime(n.createdAt)}</Td>
                  <Td>
                    <Badge tone={n.severity === 'CRITICAL' || n.severity === 'ERROR' ? 'red' : n.severity === 'WARNING' ? 'amber' : 'gray'}>{n.type}</Badge>
                  </Td>
                  <Td className="text-[13px] font-medium">{n.title}</Td>
                  <Td className="max-w-xl text-xs text-muted">{n.body}</Td>
                  <Td className="text-[11px] text-muted">{n.deliveryStatus}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

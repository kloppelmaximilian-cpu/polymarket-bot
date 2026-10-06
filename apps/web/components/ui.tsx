import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { NO_DATA, humanize, pnlClass, score as fmtScore, toNum } from '@/lib/format';

export { clsx };

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className, bodyClassName }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={clsx('rounded-lg border border-border bg-surface', className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
            {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={clsx('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, hint, tone, badge, href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'positive' | 'negative' | 'warning' | 'muted'; badge?: ReactNode; href?: string }) {
  const body = (
    <div className="h-full rounded-lg border border-border bg-surface p-4 transition-colors hover:border-surface-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">{label}</span>
        {badge}
      </div>
      <div className={clsx('num mt-2 text-2xl font-semibold', tone === 'positive' && 'text-positive', tone === 'negative' && 'text-negative', tone === 'warning' && 'text-warning', tone === 'muted' && 'text-muted')}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

const TONES = {
  gray: 'bg-surface-3 text-muted border-border',
  blue: 'bg-accent/15 text-accent border-accent/30',
  green: 'bg-positive/15 text-positive border-positive/30',
  red: 'bg-negative/15 text-negative border-negative/30',
  amber: 'bg-warning/15 text-warning border-warning/30',
  sky: 'bg-info/15 text-info border-info/30',
  purple: 'bg-demo/15 text-demo border-demo/30',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = 'gray', title, className }: { children: ReactNode; tone?: Tone; title?: string; className?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] leading-none font-semibold tracking-wide whitespace-nowrap uppercase', TONES[tone], className)}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  DISCOVERED: 'gray',
  RESEARCHING: 'sky',
  PROTOTYPE: 'sky',
  BACKTESTING: 'purple',
  EVALUATING: 'sky',
  PAPER: 'blue',
  PROMISING: 'green',
  PROBATION: 'amber',
  READY_FOR_LIVE_REVIEW: 'green',
  PAUSED: 'amber',
  FAILED: 'red',
  ARCHIVED: 'gray',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'gray'} title={status === 'READY_FOR_LIVE_REVIEW' ? 'Ready for a manual review only — live trading stays disabled' : undefined}>
      {status === 'READY_FOR_LIVE_REVIEW' ? 'Ready for live review' : humanize(status)}
    </Badge>
  );
}

const PROVENANCE: Record<string, { tone: Tone; label: string; title: string }> = {
  HISTORICAL: { tone: 'sky', label: 'Historical', title: 'Backtest on recorded historical market data' },
  SIMULATED: { tone: 'purple', label: 'Simulated', title: 'Simulated operation of a business model (not observed)' },
  PAPER: { tone: 'blue', label: 'Paper', title: 'Virtual money on live market data' },
  ESTIMATED: { tone: 'amber', label: 'Estimated', title: 'Monte Carlo estimate from unverified assumptions' },
  HYPOTHETICAL: { tone: 'gray', label: 'Hypothetical', title: 'Hypothetical — no data behind it' },
  DEMO: { tone: 'purple', label: 'DEMO', title: 'Synthetic demo data — says nothing about real markets' },
};

export function ProvenanceBadge({ provenance }: { provenance: string | null | undefined }) {
  if (!provenance) return <Badge tone="gray">No data</Badge>;
  const p = PROVENANCE[provenance] ?? { tone: 'gray' as Tone, label: provenance, title: provenance };
  return (
    <Badge tone={p.tone} title={p.title} className={provenance === 'DEMO' ? 'ring-1 ring-demo/50' : undefined}>
      {p.label}
    </Badge>
  );
}

export function RiskBadge({ level }: { level: string }) {
  const tone: Tone = level === 'LOW' ? 'green' : level === 'MEDIUM' ? 'sky' : level === 'HIGH' ? 'amber' : 'red';
  return <Badge tone={tone}>{humanize(level)}</Badge>;
}

export function ConfidenceBadge({ confidence }: { confidence: string | null | undefined }) {
  if (!confidence) return <span className="text-xs text-muted">—</span>;
  const tone: Tone = confidence === 'HIGH' ? 'green' : confidence === 'MEDIUM' ? 'sky' : 'gray';
  return <Badge tone={tone}>{confidence.toLowerCase()} conf.</Badge>;
}

export function HealthDot({ status, label }: { status: string; label?: string }) {
  const color = ['ONLINE', 'CONNECTED', 'NORMAL', 'OK'].includes(status) ? 'bg-positive' : ['DEGRADED', 'STALE', 'WARNING', 'ELEVATED'].includes(status) ? 'bg-warning' : status === 'UNKNOWN' ? 'bg-muted' : 'bg-negative';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('inline-block size-2 rounded-full', color)} />
      {label !== undefined ? <span>{label}</span> : <span className="text-xs">{status}</span>}
    </span>
  );
}

export function NoData({ children = NO_DATA }: { children?: ReactNode }) {
  return <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">{children}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
      <div className="text-sm font-semibold text-muted uppercase">{title}</div>
      {children ? <div className="mx-auto mt-2 max-w-xl text-xs text-muted">{children}</div> : null}
    </div>
  );
}

/** Signed money/number with colour; NO DATA when missing. */
export function Pnl({ value, format }: { value: unknown; format: (v: unknown) => string }) {
  const n = toNum(value);
  if (n === null) return <NoData />;
  return <span className={clsx('num', pnlClass(n))}>{format(n)}</span>;
}

export function ScoreBar({ value, small }: { value: number | null | undefined; small?: boolean }) {
  const n = toNum(value);
  if (n === null) return <NoData />;
  const color = n >= 70 ? 'bg-positive' : n >= 45 ? 'bg-accent' : n >= 25 ? 'bg-warning' : 'bg-negative';
  return (
    <span className="inline-flex items-center gap-2">
      <span className={clsx('relative overflow-hidden rounded-full bg-surface-3', small ? 'h-1.5 w-12' : 'h-2 w-20')}>
        <span className={clsx('absolute inset-y-0 left-0 rounded-full', color)} style={{ width: `${Math.max(2, Math.min(100, n))}%` }} />
      </span>
      <span className="num text-sm font-semibold">{fmtScore(n)}</span>
    </span>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto', className)}>
      <table className="w-full text-left text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, className, title }: { children?: ReactNode; className?: string; title?: string }) {
  return (
    <th title={title} className={clsx('sticky top-0 border-b border-border bg-surface px-3 py-2 text-[11px] font-semibold tracking-wider whitespace-nowrap text-muted uppercase', className)}>
      {children}
    </th>
  );
}

export function Td({ children, className, title }: { children?: ReactNode; className?: string; title?: string }) {
  return (
    <td title={title} className={clsx('border-b border-border/60 px-3 py-2 align-top', className)}>
      {children}
    </td>
  );
}

export function KeyValues({ rows, className }: { rows: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={clsx('grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]', className)}>
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="num min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ tone = 'gray', title, children }: { tone?: Tone; title?: ReactNode; children: ReactNode }) {
  return (
    <div className={clsx('rounded-md border px-3 py-2 text-[13px]', TONES[tone])}>
      {title ? <div className="mb-0.5 font-semibold">{title}</div> : null}
      <div className="text-text/90">{children}</div>
    </div>
  );
}

export function ExperimentLink({ id, name }: { id: string; name: string }) {
  return (
    <Link href={`/experiments/${id}`} className="font-medium hover:text-accent hover:underline">
      {name}
    </Link>
  );
}

export function ButtonLink({ href, children, variant = 'secondary' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' }) {
  return (
    <Link href={href} className={clsx('inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium', variant === 'primary' ? 'border-accent bg-accent text-white hover:opacity-90' : 'border-border bg-surface-2 hover:bg-surface-3')}>
      {children}
    </Link>
  );
}

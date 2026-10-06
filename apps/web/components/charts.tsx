'use client';

import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from 'recharts';

const PALETTE = ['#5b8cff', '#2fbf71', '#f5a524', '#c084fc', '#38bdf8', '#f05252', '#14b8a6', '#eab308', '#f472b6', '#a3e635', '#fb923c', '#94a3b8'];
const AXIS = { stroke: 'var(--muted)', fontSize: 11, tickLine: false, axisLine: false } as const;
const GRID = <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />;
const tooltipStyle = { contentStyle: { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--text)' }, labelStyle: { color: 'var(--muted)' } };

const fmtDate = (ts: number) => {
  const d = new Date(ts);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const fmtDateTime = (ts: unknown) => (typeof ts === 'number' ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : String(ts));
const compact = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(Math.abs(v) >= 10_000 ? 0 : 1)}k` : v.toFixed(Math.abs(v) < 10 ? 2 : 0));

function NoChart({ height, label = 'NO DATA' }: { height: number; label?: string }) {
  return (
    <div className="flex items-center justify-center rounded-md border border-dashed border-border text-[11px] font-semibold tracking-wider text-muted uppercase" style={{ height }}>
      {label}
    </div>
  );
}

export interface Point {
  ts: number;
  value: number;
}

/** Equity over time with an optional starting-capital reference line. */
export function EquityChart({ points, baseline, height = 240, label = 'Equity' }: { points: Point[]; baseline?: number; height?: number; label?: string }) {
  if (points.length < 2) return <NoChart height={height} label="NO DATA — not enough points for a curve" />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5b8cff" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#5b8cff" stopOpacity={0} />
          </linearGradient>
        </defs>
        {GRID}
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtDate} {...AXIS} minTickGap={40} />
        <YAxis domain={['auto', 'auto']} tickFormatter={compact} width={52} {...AXIS} />
        <Tooltip {...tooltipStyle} labelFormatter={fmtDateTime} formatter={(v) => [Number(v).toFixed(2), label]} />
        {baseline !== undefined ? <ReferenceLine y={baseline} stroke="var(--muted)" strokeDasharray="4 4" /> : null}
        <Area type="monotone" dataKey="value" stroke="#5b8cff" strokeWidth={1.6} fill="url(#eq)" isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Drawdown (0 … −x %) derived from an equity curve. */
export function DrawdownChart({ points, height = 140 }: { points: Point[]; height?: number }) {
  if (points.length < 2) return <NoChart height={height} />;
  let peak = -Infinity;
  const dd = points.map((p) => {
    peak = Math.max(peak, p.value);
    return { ts: p.ts, value: peak > 0 ? ((p.value - peak) / peak) * 100 : 0 };
  });
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={dd} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        {GRID}
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtDate} {...AXIS} minTickGap={40} />
        <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} width={52} {...AXIS} />
        <Tooltip {...tooltipStyle} labelFormatter={fmtDateTime} formatter={(v) => [`${Number(v).toFixed(2)} %`, 'Drawdown']} />
        <Area type="monotone" dataKey="value" stroke="#f05252" fill="#f05252" fillOpacity={0.2} isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface Series {
  name: string;
  points: Point[];
  dashed?: boolean;
}

/** Several curves on one time axis (each with its own timestamps). */
export function MultiLineChart({ series, height = 300, yFormat = 'index' }: { series: Series[]; height?: number; yFormat?: 'index' | 'usd' }) {
  const usable = series.filter((s) => s.points.length >= 2);
  if (usable.length === 0) return <NoChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {GRID}
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtDate} {...AXIS} minTickGap={40} allowDuplicatedCategory={false} />
        <YAxis domain={['auto', 'auto']} tickFormatter={yFormat === 'usd' ? compact : (v: number) => v.toFixed(0)} width={52} {...AXIS} />
        <Tooltip {...tooltipStyle} labelFormatter={fmtDateTime} formatter={(v, n) => [Number(v).toFixed(2), n]} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {yFormat === 'index' ? <ReferenceLine y={100} stroke="var(--muted)" strokeDasharray="4 4" /> : null}
        {usable.map((s, i) => (
          <Line key={s.name} data={s.points} dataKey="value" name={s.name} stroke={PALETTE[i % PALETTE.length]} strokeWidth={1.5} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface FanRow {
  month: number;
  p10: number;
  p50: number;
  p90: number;
}

/** Monte Carlo fan: P10–P90 band with the median line (business estimates). */
export function FanChart({ rows, height = 260, label }: { rows: FanRow[]; height?: number; label: string }) {
  if (rows.length < 2) return <NoChart height={height} />;
  const data = rows.map((r) => ({ month: r.month, band: [r.p10, r.p90] as [number, number], p50: r.p50 }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {GRID}
        <XAxis dataKey="month" {...AXIS} tickFormatter={(m: number) => `M${m}`} />
        <YAxis tickFormatter={compact} width={52} {...AXIS} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(m) => `Month ${String(m)}`}
          formatter={(v, n) => (Array.isArray(v) ? [`${compact(Number(v[0]))} … ${compact(Number(v[1]))}`, 'P10 … P90'] : [compact(Number(v)), n === 'p50' ? `${label} (median)` : n])}
        />
        <ReferenceLine y={0} stroke="var(--muted)" />
        <Area dataKey="band" stroke="none" fill="#c084fc" fillOpacity={0.22} isAnimationActive={false} name="P10 … P90" />
        <Line dataKey="p50" stroke="#c084fc" strokeWidth={2} dot={false} isAnimationActive={false} name="p50" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export interface BarRow {
  label: string;
  value: number;
}

/** Simple vertical bars; negative values are red. */
export function Bars({ rows, height = 220, format = 'number' }: { rows: BarRow[]; height?: number; format?: 'number' | 'pct' | 'usd' }) {
  if (rows.length === 0) return <NoChart height={height} />;
  const f = (v: number) => (format === 'pct' ? `${(v * 100).toFixed(1)}%` : format === 'usd' ? compact(v) : v.toFixed(2));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {GRID}
        <XAxis dataKey="label" {...AXIS} interval={0} tick={{ fontSize: 10 }} angle={rows.length > 6 ? -30 : 0} textAnchor={rows.length > 6 ? 'end' : 'middle'} height={rows.length > 6 ? 64 : 30} />
        <YAxis tickFormatter={f} width={52} {...AXIS} />
        <Tooltip {...tooltipStyle} formatter={(v) => [f(Number(v)), 'Value']} />
        <ReferenceLine y={0} stroke="var(--muted)" />
        <Bar dataKey="value" isAnimationActive={false} radius={[3, 3, 0, 0]}>
          {rows.map((r) => (
            <Cell key={r.label} fill={r.value >= 0 ? '#2fbf71' : '#f05252'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface TornadoRow {
  label: string;
  low: number;
  high: number;
}

/** Sensitivity tornado: profit at the low and high value of each assumption, relative to the median. */
export function Tornado({ rows, base, height }: { rows: TornadoRow[]; base: number; height?: number }) {
  if (rows.length === 0) return <NoChart height={height ?? 200} />;
  const data = rows.map((r) => ({ label: r.label.length > 38 ? `${r.label.slice(0, 37)}…` : r.label, low: r.low - base, high: r.high - base }));
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(160, rows.length * 38 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 0, left: 8 }} barGap={1}>
        {GRID}
        <XAxis type="number" tickFormatter={compact} {...AXIS} />
        <YAxis type="category" dataKey="label" width={200} {...AXIS} tick={{ fontSize: 10.5 }} />
        <Tooltip {...tooltipStyle} formatter={(v, n) => [`${Number(v) >= 0 ? '+' : ''}${compact(Number(v))} vs median`, n === 'low' ? 'at low value' : 'at high value']} />
        <ReferenceLine x={0} stroke="var(--muted)" />
        <Bar dataKey="low" fill="#f5a524" isAnimationActive={false} />
        <Bar dataKey="high" fill="#5b8cff" isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
